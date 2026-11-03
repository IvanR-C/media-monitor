"""Tests for authentication: first-run setup, login/logout, the _require_auth
guard, and the passkey (WebAuthn) registration + MFA login flow.

The passkey tests drive a real (software) authenticator — a generated P-256
key pair wrapped in genuine CBOR/COSE structures — through the actual
`webauthn` verification calls in app.py, rather than mocking the library.
This exercises our integration code (challenge storage, session state,
sign-count persistence) against the real cryptographic checks.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import struct

import cbor2
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


class FakeAuthenticator:
    """A minimal software WebAuthn authenticator for test purposes."""

    def __init__(self):
        self.private_key = ec.generate_private_key(ec.SECP256R1())
        self.credential_id = secrets.token_bytes(32)

    def _cose_public_key(self) -> bytes:
        numbers = self.private_key.public_key().public_numbers()
        x = numbers.x.to_bytes(32, "big")
        y = numbers.y.to_bytes(32, "big")
        return cbor2.dumps({1: 2, 3: -7, -1: 1, -2: x, -3: y})

    def create(self, rp_id: str, challenge_b64url: str, origin: str) -> dict:
        """Simulate navigator.credentials.create() -> registration response JSON."""
        rp_id_hash = hashlib.sha256(rp_id.encode()).digest()
        flags = 0x45  # UP + UV + AT
        auth_data = (
            rp_id_hash
            + bytes([flags])
            + struct.pack(">I", 0)
            + b"\x00" * 16  # aaguid
            + struct.pack(">H", len(self.credential_id))
            + self.credential_id
            + self._cose_public_key()
        )
        attestation_object = cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth_data})
        client_data = json.dumps({
            "type": "webauthn.create",
            "challenge": challenge_b64url,
            "origin": origin,
            "crossOrigin": False,
        }).encode()
        return {
            "id": _b64url(self.credential_id),
            "rawId": _b64url(self.credential_id),
            "type": "public-key",
            "response": {
                "clientDataJSON": _b64url(client_data),
                "attestationObject": _b64url(attestation_object),
            },
        }

    def get(self, rp_id: str, challenge_b64url: str, origin: str, sign_count: int = 1) -> dict:
        """Simulate navigator.credentials.get() -> authentication response JSON."""
        rp_id_hash = hashlib.sha256(rp_id.encode()).digest()
        flags = 0x05  # UP + UV
        auth_data = rp_id_hash + bytes([flags]) + struct.pack(">I", sign_count)
        client_data = json.dumps({
            "type": "webauthn.get",
            "challenge": challenge_b64url,
            "origin": origin,
            "crossOrigin": False,
        }).encode()
        client_data_hash = hashlib.sha256(client_data).digest()
        signature = self.private_key.sign(auth_data + client_data_hash, ec.ECDSA(hashes.SHA256()))
        return {
            "id": _b64url(self.credential_id),
            "rawId": _b64url(self.credential_id),
            "type": "public-key",
            "response": {
                "clientDataJSON": _b64url(client_data),
                "authenticatorData": _b64url(auth_data),
                "signature": _b64url(signature),
            },
        }


# Flask's test client defaults to this host/origin absent an explicit Origin header.
RP_ID  = "localhost"
ORIGIN = "http://localhost"


# ── First-run setup ─────────────────────────────────────────────────────────

def test_status_reports_setup_required_before_setup(raw_client):
    r = raw_client.get("/api/auth/status")
    assert r.status_code == 200
    body = r.get_json()
    assert body["setup_required"] is True
    assert body["authenticated"] is False


def test_setup_rejects_short_password(raw_client):
    r = raw_client.post("/api/auth/setup", json={"username": "admin", "password": "short"})
    assert r.status_code == 400


def test_setup_then_authenticated(raw_client):
    r = raw_client.post("/api/auth/setup", json={"username": "admin", "password": "correct-horse-123"})
    assert r.status_code == 200

    r = raw_client.get("/api/auth/status")
    body = r.get_json()
    assert body["setup_required"] is False
    assert body["authenticated"] is True
    assert body["username"] == "admin"


def test_setup_cannot_run_twice(raw_client):
    raw_client.post("/api/auth/setup", json={"username": "admin", "password": "correct-horse-123"})
    r = raw_client.post("/api/auth/setup", json={"username": "attacker", "password": "takeover-attempt1"})
    assert r.status_code == 403

    # The original admin must still be the one in effect.
    status = raw_client.get("/api/auth/status").get_json()
    assert status["username"] == "admin"


# ── Guard behavior ───────────────────────────────────────────────────────────

def test_api_blocked_before_setup(raw_client):
    r = raw_client.get("/api/stats")
    assert r.status_code == 401
    assert r.get_json()["error"] == "setup_required"


def test_health_exempt_from_guard(raw_client):
    r = raw_client.get("/api/health")
    assert r.status_code == 200


def test_api_blocked_without_session(app_module):
    app_module.app.config["TESTING"] = True
    with app_module.app.test_client() as setup_client:
        setup_client.post("/api/auth/setup", json={"username": "admin", "password": "correct-horse-123"})

    # A fresh client (no session cookie) against the now-configured app.
    with app_module.app.test_client() as other_client:
        r = other_client.get("/api/stats")
        assert r.status_code == 401
        assert r.get_json()["error"] == "authentication_required"


# ── Login / logout / lockout ─────────────────────────────────────────────────

def test_login_wrong_password_rejected(raw_client):
    raw_client.post("/api/auth/setup", json={"username": "admin", "password": "correct-horse-123"})
    raw_client.post("/api/auth/logout")

    r = raw_client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    assert r.status_code == 401


def test_login_success_grants_access(raw_client):
    raw_client.post("/api/auth/setup", json={"username": "admin", "password": "correct-horse-123"})
    raw_client.post("/api/auth/logout")
    assert raw_client.get("/api/stats").status_code == 401

    r = raw_client.post("/api/auth/login", json={"username": "admin", "password": "correct-horse-123"})
    assert r.status_code == 200
    assert r.get_json()["status"] == "ok"
    assert raw_client.get("/api/stats").status_code == 200


def test_login_lockout_after_repeated_failures(raw_client):
    raw_client.post("/api/auth/setup", json={"username": "admin", "password": "correct-horse-123"})
    raw_client.post("/api/auth/logout")

    for _ in range(5):
        r = raw_client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
        assert r.status_code == 401

    r = raw_client.post("/api/auth/login", json={"username": "admin", "password": "correct-horse-123"})
    assert r.status_code == 429


def test_change_password(client):
    r = client.post("/api/auth/change-password", json={
        "current_password": "testpassword123",
        "new_password": "a-new-password-456",
    })
    assert r.status_code == 200

    client.post("/api/auth/logout")
    r = client.post("/api/auth/login", json={"username": "test-admin", "password": "a-new-password-456"})
    assert r.status_code == 200


def test_change_password_wrong_current_rejected(client):
    r = client.post("/api/auth/change-password", json={
        "current_password": "not-the-password",
        "new_password": "a-new-password-456",
    })
    assert r.status_code == 401


# ── Passkeys / MFA ────────────────────────────────────────────────────────────

def _register_passkey(client, authenticator: FakeAuthenticator, name="My Passkey"):
    options = client.post("/api/auth/passkeys/register/options").get_json()
    attestation = authenticator.create(RP_ID, options["challenge"], ORIGIN)
    return client.post(
        "/api/auth/passkeys/register/verify",
        json={"name": name, "credential": attestation},
    )


def test_register_passkey(client):
    authenticator = FakeAuthenticator()
    r = _register_passkey(client, authenticator)
    assert r.status_code == 200

    passkeys = client.get("/api/auth/passkeys").get_json()["passkeys"]
    assert len(passkeys) == 1
    assert passkeys[0]["name"] == "My Passkey"


def test_enable_mfa_requires_a_passkey_first(client):
    r = client.post("/api/auth/mfa", json={"require_passkey_mfa": True})
    assert r.status_code == 400


def test_full_password_plus_passkey_mfa_login(client):
    authenticator = FakeAuthenticator()
    assert _register_passkey(client, authenticator).status_code == 200
    assert client.post("/api/auth/mfa", json={"require_passkey_mfa": True}).status_code == 200

    client.post("/api/auth/logout")
    status = client.get("/api/auth/status").get_json()
    assert status["authenticated"] is False

    # Password step — should demand MFA rather than fully authenticating.
    r = client.post("/api/auth/login", json={"username": "test-admin", "password": "testpassword123"})
    assert r.status_code == 200
    assert r.get_json()["status"] == "mfa_required"
    assert client.get("/api/stats").status_code == 401  # not authenticated yet

    # Passkey step.
    options = client.post("/api/auth/passkeys/login/options").get_json()
    assertion = authenticator.get(RP_ID, options["challenge"], ORIGIN, sign_count=1)
    r = client.post("/api/auth/passkeys/login/verify", json={"credential": assertion})
    assert r.status_code == 200
    assert r.get_json()["status"] == "ok"

    assert client.get("/api/stats").status_code == 200
    status = client.get("/api/auth/status").get_json()
    assert status["authenticated"] is True


def test_passkey_login_options_requires_pending_mfa(client):
    authenticator = FakeAuthenticator()
    _register_passkey(client, authenticator)
    r = client.post("/api/auth/passkeys/login/options")
    assert r.status_code == 400


def test_deleting_last_passkey_disables_mfa(client):
    authenticator = FakeAuthenticator()
    _register_passkey(client, authenticator)
    client.post("/api/auth/mfa", json={"require_passkey_mfa": True})

    passkey_id = client.get("/api/auth/passkeys").get_json()["passkeys"][0]["id"]
    r = client.delete(f"/api/auth/passkeys/{passkey_id}")
    assert r.status_code == 200

    status = client.get("/api/auth/status").get_json()
    assert status["require_passkey_mfa"] is False
    assert status["passkey_count"] == 0
