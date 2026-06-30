import subprocess
import datetime
import sys
import os

# Configuration
BACKEND_REPO = "ivanchelo/media-monitor"
FRONTEND_REPO = "ivanchelo/media-monitor-frontend"

def get_next_version(repo):
    """
    Fetches tags from Docker Hub/Local, finds the highest version for
    today's date, and returns the next increment.
    Format: MM.DD.YY.N
    """
    today_prefix = datetime.datetime.now().strftime("%m.%d.%y")

    # Get local tags for this repo
    try:
        result = subprocess.check_output(
            ["docker", "images", "--format", "{{.Tag}}", repo],
            universal_newlines=True
        )
        tags = result.strip().split('\n')
    except Exception:
        tags = []

    # Filter tags that start with today's date and find the max increment
    increments = [0]
    for tag in tags:
        if tag.startswith(today_prefix):
            try:
                # Extracts the 'N' from 'MM.DD.YY.N'
                suffix = int(tag.split('.')[-1])
                increments.append(suffix)
            except ValueError:
                continue

    next_increment = max(increments) + 1
    return f"{today_prefix}.{next_increment}"

def run_command(command, cwd=None):
    """Helper to run shell commands and stop on failure."""
    print(f"Executing: {' '.join(command)}")
    result = subprocess.run(command, cwd=cwd)
    if result.returncode != 0:
        print(f"Error: Command failed with exit code {result.returncode}")
        sys.exit(1)

def main():
    # 1. Determine the version (based on backend repo)
    version = get_next_version(BACKEND_REPO)
    print(f"--- Target Version: {version} ---")

    # 2. Build & Push Backend (Root directory)
    print("\nBuilding Backend...")
    run_command(["docker", "build", "-t", f"{BACKEND_REPO}:{version}", "-t", f"{BACKEND_REPO}:latest", "."])

    print("\nPushing Backend...")
    run_command(["docker", "push", f"{BACKEND_REPO}:{version}"])
    run_command(["docker", "push", f"{BACKEND_REPO}:latest"])

    # 3. Build & Push Frontend
    print("\nBuilding Frontend...")
    frontend_dir = os.path.join(os.getcwd(), "frontend")
    run_command(["docker", "build", "-t", f"{FRONTEND_REPO}:{version}", "-t", f"{FRONTEND_REPO}:latest", "."], cwd=frontend_dir)

    print("\nPushing Frontend...")
    run_command(["docker", "push", f"{FRONTEND_REPO}:{version}"])
    run_command(["docker", "push", f"{FRONTEND_REPO}:latest"])

    print(f"\nSuccessfully deployed version {version}!")

if __name__ == "__main__":
    main()
