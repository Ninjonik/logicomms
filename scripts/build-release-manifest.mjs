import fs from "node:fs";
import path from "node:path";

const releaseDir = path.resolve(
  process.env.RELEASE_DIR ?? "src-tauri/target/release/bundle/nsis"
);
const outputPath = path.resolve(
  process.env.OUTPUT_PATH ?? "backend/releases/latest.json"
);
const baseUrl = (
  process.env.BASE_URL ?? "https://logicomms.igportals.eu/downloads"
).replace(/\/$/u, "");
const version = process.env.VERSION;
const notes = process.env.NOTES ?? "";
const artifactName = process.env.ARTIFACT_NAME;

if (!version) {
  throw new Error("VERSION is required.");
}

const files = fs.readdirSync(releaseDir);
const installerName =
  artifactName ??
  files.find((file) => file.endsWith("-setup.exe")) ??
  files.find((file) => file.endsWith(".exe"));

if (!installerName) {
  throw new Error(`No Windows installer found in ${releaseDir}`);
}

const signaturePath = path.join(releaseDir, `${installerName}.sig`);
if (!fs.existsSync(signaturePath)) {
  throw new Error(`Missing signature file for ${installerName}`);
}

const manifest = {
  notes,
  platforms: {
    "windows-x86_64": {
      signature: fs.readFileSync(signaturePath, "utf8").trim(),
      url: `${baseUrl}/${installerName}`,
    },
  },
  pub_date: new Date().toISOString(),
  version,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
