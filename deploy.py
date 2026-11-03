import subprocess
import datetime
import sys

# Configuration — single merged image (Flask backend + static Next.js frontend)
IMAGE_REPO = "ivanchelo/media-monitor"

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
    # 1. Determine the version
    version = get_next_version(IMAGE_REPO)
    print(f"--- Target Version: {version} ---")

    # 2. Build & Push (Root directory — Dockerfile builds the frontend static
    #    export in its own stage, so this is the only image to produce)
    print("\nBuilding...")
    run_command(["docker", "build", "-t", f"{IMAGE_REPO}:{version}", "-t", f"{IMAGE_REPO}:latest", "."])

    print("\nPushing...")
    run_command(["docker", "push", f"{IMAGE_REPO}:{version}"])
    run_command(["docker", "push", f"{IMAGE_REPO}:latest"])

    print(f"\nSuccessfully deployed version {version}!")

if __name__ == "__main__":
    main()
