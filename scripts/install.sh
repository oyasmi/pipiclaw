#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
	echo "error: node is required but was not found in PATH" >&2
	exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
	echo "error: npm is required but was not found in PATH" >&2
	exit 1
fi

cd -- "$PROJECT_ROOT"

PACKAGE_NAME="$(node -p "require('./package.json').name")"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"

echo "Installing ${PACKAGE_NAME}@${PACKAGE_VERSION} from $PROJECT_ROOT"

# Build a package tarball first so the local installation has exactly the same
# file set as the package published to npm (in particular, the compiled dist/).
npm install
npm run build

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pipiclaw-install.XXXXXX")"
cleanup() {
	rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT

PACKAGE_FILE="$(npm pack --silent --pack-destination "$TEMP_DIR")"
PACKAGE_PATH="$TEMP_DIR/$PACKAGE_FILE"

if [[ ! -f "$PACKAGE_PATH" ]]; then
	echo "error: npm pack did not create the expected package: $PACKAGE_PATH" >&2
	exit 1
fi

npm install --global "$PACKAGE_PATH"

echo "Installed ${PACKAGE_NAME}@${PACKAGE_VERSION} successfully."
echo "Run 'pipiclaw --help' to verify the installation."
