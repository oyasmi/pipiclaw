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

DRY_RUN=false
case "${1:-}" in
	"") ;;
	--dry-run) DRY_RUN=true ;;
	*)
		echo "usage: $0 [--dry-run]" >&2
		exit 2
		;;
esac

if [[ $# -gt 1 ]]; then
	echo "usage: $0 [--dry-run]" >&2
	exit 2
fi

cd -- "$PROJECT_ROOT"

PACKAGE_NAME="$(node -p "require('./package.json').name")"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
NPM_REGISTRY="$(npm config get registry)"

case "$NPM_REGISTRY" in
	http://* | https://*) ;;
	*)
		echo "error: npm registry must be an HTTP(S) URL, got '$NPM_REGISTRY'" >&2
		exit 1
		;;
esac

# Prefer the conventional NPM_TOKEN name while remaining compatible with
# tooling that exposes the same credential as NODE_AUTH_TOKEN.
ACCESS_TOKEN="${NPM_TOKEN:-${NODE_AUTH_TOKEN:-}}"
TOKEN_CONFIG=""

cleanup() {
	if [[ -n "$TOKEN_CONFIG" && -f "$TOKEN_CONFIG" ]]; then
		rm -f -- "$TOKEN_CONFIG"
	fi
}
trap cleanup EXIT

if [[ -n "$ACCESS_TOKEN" ]]; then
	REGISTRY_AUTH_SCOPE="${NPM_REGISTRY#http://}"
	REGISTRY_AUTH_SCOPE="${REGISTRY_AUTH_SCOPE#https://}"
	REGISTRY_AUTH_SCOPE="${REGISTRY_AUTH_SCOPE%/}/"

	umask 077
	TOKEN_CONFIG="$(mktemp "${TMPDIR:-/tmp}/pipiclaw-npmrc.XXXXXX")"
	{
		printf 'registry=%s\n' "$NPM_REGISTRY"
		printf '//%s:_authToken=%s\n' "$REGISTRY_AUTH_SCOPE" "$ACCESS_TOKEN"
	} >"$TOKEN_CONFIG"
	export NPM_CONFIG_USERCONFIG="$TOKEN_CONFIG"

	echo "Using npm access token from the environment."
else
	if [[ ! -t 0 || ! -t 1 ]]; then
		echo "error: npm authentication is required, but no access token was found" >&2
		echo "Set NPM_TOKEN (or NODE_AUTH_TOKEN), or run this script in an interactive terminal to log in." >&2
		exit 1
	fi

	echo "No npm access token found; starting interactive login for $NPM_REGISTRY"
	npm login --registry "$NPM_REGISTRY"
fi

# Fail before the expensive prepublishOnly checks when authentication is bad.
npm whoami --registry "$NPM_REGISTRY" >/dev/null

# npm publishes without an explicit tag to "latest". Never let a prerelease
# accidentally become latest: beta versions are published under the beta tag,
# while unknown prerelease channels require an explicit script update.
VERSION_WITHOUT_BUILD="${PACKAGE_VERSION%%+*}"
PUBLISH_ARGS=(--access public)

if [[ "$VERSION_WITHOUT_BUILD" == *-* ]]; then
	PRERELEASE="${VERSION_WITHOUT_BUILD#*-}"
	case "$PRERELEASE" in
		beta | beta.*)
			PUBLISH_ARGS+=(--tag beta)
			;;
		*)
			echo "error: unsupported prerelease version '$PACKAGE_VERSION'" >&2
			echo "Add an explicit dist-tag rule before publishing this prerelease channel." >&2
			exit 1
			;;
	esac
fi

if [[ "$DRY_RUN" == true ]]; then
	PUBLISH_ARGS+=(--dry-run)
fi

printf 'Publishing %s@%s with:' "$PACKAGE_NAME" "$PACKAGE_VERSION"
printf ' npm publish'
printf ' %q' "${PUBLISH_ARGS[@]}"
printf '\n'

# package.json's prepublishOnly hook performs clean, build, and all checks.
npm publish "${PUBLISH_ARGS[@]}"
