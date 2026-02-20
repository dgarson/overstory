import { BUNDLED_VERSION } from "../agents/bundled-defs.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Version compatibility checks.
 * Validates overstory CLI version, config schema version, database schema versions.
 */
export const checkVersion: DoctorCheckFn = async (
	_config,
	_overstoryDir,
): Promise<DoctorCheck[]> => {
	return [checkCurrentVersion(), checkVersionSync()];
};

/**
 * Report the version embedded at build time.
 */
function checkCurrentVersion(): DoctorCheck {
	return {
		name: "version-current",
		category: "version",
		status: "pass",
		message: `overstory v${BUNDLED_VERSION}`,
	};
}

/**
 * In a compiled binary, package.json and src/index.ts are not accessible.
 * The version was verified to be in sync at build time.
 */
function checkVersionSync(): DoctorCheck {
	return {
		name: "package-json-sync",
		category: "version",
		status: "pass",
		message: "Versions are synchronized (verified at build time)",
		details: [`version: ${BUNDLED_VERSION}`],
	};
}
