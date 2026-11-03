// Thin wrapper around the browser's WebAuthn API for passkey registration and
// login. The backend (see /api/auth/passkeys/* in app.py) exchanges base64url
// strings over JSON; the native navigator.credentials API needs ArrayBuffers,
// so all the work here is converting between the two.

function base64urlToBuffer(base64url: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4)
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes.buffer
}

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let str = ""
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential
}

async function jsonOrThrow(res: Response, fallback: string): Promise<any> {
  if (res.ok) return res.json()
  const data = await res.json().catch(() => ({}))
  throw new Error(data.error || fallback)
}

export async function registerPasskey(name: string): Promise<void> {
  const optionsRes = await fetch("/api/auth/passkeys/register/options", { method: "POST" })
  const options = await jsonOrThrow(optionsRes, "Failed to start passkey registration")

  const publicKey: CredentialCreationOptions["publicKey"] = {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
    user: { ...options.user, id: base64urlToBuffer(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((c: any) => ({
      ...c,
      id: base64urlToBuffer(c.id),
    })),
  }

  let credential: PublicKeyCredential | null
  try {
    credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "Passkey creation failed")
  }
  if (!credential) throw new Error("Passkey creation was cancelled")

  const response = credential.response as AuthenticatorAttestationResponse
  const verifyRes = await fetch("/api/auth/passkeys/register/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      credential: {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: bufferToBase64url(response.clientDataJSON),
          attestationObject: bufferToBase64url(response.attestationObject),
        },
      },
    }),
  })
  await jsonOrThrow(verifyRes, "Passkey registration failed")
}

export async function loginWithPasskey(): Promise<void> {
  const optionsRes = await fetch("/api/auth/passkeys/login/options", { method: "POST" })
  const options = await jsonOrThrow(optionsRes, "Failed to start passkey sign-in")

  const publicKey: CredentialRequestOptions["publicKey"] = {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((c: any) => ({
      ...c,
      id: base64urlToBuffer(c.id),
    })),
  }

  let credential: PublicKeyCredential | null
  try {
    credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : "Passkey sign-in failed")
  }
  if (!credential) throw new Error("Passkey sign-in was cancelled")

  const response = credential.response as AuthenticatorAssertionResponse
  const verifyRes = await fetch("/api/auth/passkeys/login/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      credential: {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: bufferToBase64url(response.clientDataJSON),
          authenticatorData: bufferToBase64url(response.authenticatorData),
          signature: bufferToBase64url(response.signature),
          userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : undefined,
        },
      },
    }),
  })
  await jsonOrThrow(verifyRes, "Passkey verification failed")
}
