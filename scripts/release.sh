#!/usr/bin/env bash
# Bumps app.json and the iOS project version, regenerates the changelog, and
# commits + tags the changes in one step. The tag always points to that commit.
#
# Usage: scripts/release.sh X.Y.Z
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: scripts/release.sh X.Y.Z" >&2
  exit 1
fi
TAG="v${VERSION}"

if ! command -v git-cliff >/dev/null 2>&1; then
  echo "git-cliff is not installed. Install it: winget install orhun.git-cliff" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "main" ]; then
  echo "Must be on main (currently on ${BRANCH})." >&2
  exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Working tree has uncommitted changes to tracked files." >&2
  exit 1
fi

git fetch origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "main is behind origin/main. Pull first." >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "Tag ${TAG} already exists." >&2
  exit 1
fi

sed -i -E "s/(\"version\": \")[^\"]*(\")/\1${VERSION}\2/" app.json
grep -q "\"version\": \"${VERSION}\"" app.json

# Matches the versioning scheme used by Android versionCode.
IOS_BUILD=$(( ${VERSION%%.*} * 10000 \
  + $(echo "${VERSION}" | cut -d. -f2) * 100 \
  + $(echo "${VERSION}" | cut -d. -f3) ))
sed -i -E "s/(MARKETING_VERSION = )[^;]*(;)/\1${VERSION}\2/" ios/Airhop.xcodeproj/project.pbxproj
sed -i -E "s/(CURRENT_PROJECT_VERSION = )[^;]*(;)/\1${IOS_BUILD}\2/" ios/Airhop.xcodeproj/project.pbxproj
grep -q "MARKETING_VERSION = ${VERSION};" ios/Airhop.xcodeproj/project.pbxproj
grep -q "CURRENT_PROJECT_VERSION = ${IOS_BUILD};" ios/Airhop.xcodeproj/project.pbxproj

git-cliff --config cliff.toml --tag "${TAG}" --output docs/dev/CHANGELOG.md

git add app.json ios/Airhop.xcodeproj/project.pbxproj docs/dev/CHANGELOG.md
# No [skip ci]: GitHub applies it to a tag push of this commit too, and the tag
# push is what starts the release workflow.
git commit -m "chore(release): set version and changelog for ${TAG}"
git tag -a "${TAG}" -m "${TAG}"

echo
echo "Tagged ${TAG} at $(git rev-parse --short HEAD). Review the commit, then:"
echo "  git push origin main"
# Qualified, because git refuses a bare name that matches a local branch too.
echo "  git push origin refs/tags/${TAG}"
