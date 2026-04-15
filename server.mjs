import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4545);
const HOST = process.env.HOST || "127.0.0.1";
const REGISTRY_PATH = path.join(__dirname, "registry.json");

const LOCAL_PACK_PATHS = {
  "toolcall-15": path.resolve(__dirname, "../ToolCall-15"),
  "bugfind-15": path.resolve(__dirname, "../BugFind-15"),
  "dataextract-15": path.resolve(__dirname, "../DataExtract-15"),
  "instructfollow-15": path.resolve(__dirname, "../InstructFollow-15"),
  "reasonmath-15": path.resolve(__dirname, "../ReasonMath-15"),
  "structoutput-15": path.resolve(__dirname, "../StructOutput-15"),
  "hermesagent-20": path.resolve(__dirname, "../HermesAgent-20")
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function loadRegistry() {
  const raw = await fs.readFile(REGISTRY_PATH, "utf8");
  const registry = JSON.parse(raw);

  if (registry?.schemaVersion !== 1 || !Array.isArray(registry?.packs)) {
    throw new Error("registry.json is invalid.");
  }

  return registry;
}

async function loadLocalManifest(packRoot) {
  const manifestPath = path.join(packRoot, "benchlocal.pack.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(raw);
}

function validateRegistryEntry(entry) {
  if (!entry?.id || !entry?.name || !entry?.author || !entry?.description || !entry?.version) {
    throw new Error(`Registry entry is missing required metadata for "${entry?.id || "unknown"}".`);
  }

  if (!entry?.source?.type) {
    throw new Error(`Registry entry "${entry.id}" is missing source metadata.`);
  }
}

function validateRegistryAgainstManifest(entry, manifest) {
  const mismatches = [];

  const check = (label, registryValue, manifestValue) => {
    if (registryValue !== manifestValue) {
      mismatches.push(`${label}: registry="${registryValue}" manifest="${manifestValue}"`);
    }
  };

  check("id", entry.id, manifest.id);
  check("name", entry.name, manifest.name);
  check("author", entry.author, manifest.author);
  check("description", entry.description, manifest.description);
  check("version", entry.version, manifest.version);
  check("capabilities.tools", entry.capabilities?.tools, manifest.capabilities?.tools);
  check("capabilities.multiTurn", entry.capabilities?.multiTurn, manifest.capabilities?.multiTurn);
  check("capabilities.verification", entry.capabilities?.verification, manifest.capabilities?.verification);

  if (mismatches.length > 0) {
    throw new Error(`Registry entry "${entry.id}" is out of sync with benchlocal.pack.json:\n- ${mismatches.join("\n- ")}`);
  }
}

async function loadRegistryForLocalServer() {
  const registry = await loadRegistry();

  for (const entry of registry.packs) {
    validateRegistryEntry(entry);
    const localPath = LOCAL_PACK_PATHS[entry.id];

    if (!localPath) {
      throw new Error(`No local path mapping exists for Bench Pack "${entry.id}".`);
    }

    const manifest = await loadLocalManifest(localPath);
    validateRegistryAgainstManifest(entry, manifest);
  }

  return registry;
}

async function ensureBenchLocalBuild(packRoot, packId) {
  const packageJsonPath = path.join(packRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const hasBenchLocalBuild = typeof packageJson?.scripts?.["build:benchlocal"] === "string";

  if (!hasBenchLocalBuild) {
    throw new Error(`Bench Pack "${packId}" does not define a build:benchlocal script.`);
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  await runCommand(npmCommand, ["run", "build:benchlocal"], packRoot);
}

async function collectPackArchiveEntries(packRoot) {
  const candidates = [
    "benchlocal.pack.json",
    "dist",
    "verification",
    "README.md",
    "METHODOLOGY.md",
    "package.json"
  ];

  const included = [];

  for (const relativePath of candidates) {
    try {
      const stats = await fs.stat(path.join(packRoot, relativePath));

      if (stats.isFile() || stats.isDirectory()) {
        included.push(relativePath);
      }
    } catch {
      // Optional artifact. Skip when missing.
    }
  }

  if (!included.includes("benchlocal.pack.json") || !included.includes("dist")) {
    throw new Error("Bench Pack archive is missing the required BenchLocal runtime artifacts.");
  }

  return included;
}

async function serveRegistry(request, response) {
  const registry = await loadRegistryForLocalServer();
  const baseUrl = `http://${request.headers.host || `${HOST}:${PORT}`}`;

  sendJson(response, 200, {
    schemaVersion: 1,
    packs: registry.packs.map((entry) => ({
      ...entry,
      source: {
        type: "archive",
        url: `${baseUrl}/packs/${entry.id}.tar.gz`
      }
    }))
  });
}

async function servePackArchive(packId, response) {
  const registry = await loadRegistryForLocalServer();
  const pack = registry.packs.find((entry) => entry.id === packId);

  if (!pack) {
    sendJson(response, 404, { error: `Unknown Bench Pack "${packId}".` });
    return;
  }

  const packRoot = LOCAL_PACK_PATHS[packId];

  try {
    const stats = await fs.stat(packRoot);

    if (!stats.isDirectory()) {
      sendJson(response, 404, { error: `Bench Pack directory is missing for "${packId}".` });
      return;
    }
  } catch {
    sendJson(response, 404, { error: `Bench Pack directory is missing for "${packId}".` });
    return;
  }

  let archiveEntries;

  try {
    await ensureBenchLocalBuild(packRoot, packId);
    archiveEntries = await collectPackArchiveEntries(packRoot);
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : `Failed to build archive for "${packId}".`
    });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Disposition": `attachment; filename="${packId}.tar.gz"`,
    "Cache-Control": "no-store"
  });

  const tar = spawn("tar", ["-czf", "-", "-C", packRoot, ...archiveEntries], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  tar.stdout.pipe(response);
  tar.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  tar.on("close", (code) => {
    if (code !== 0 && !response.writableEnded) {
      response.destroy(new Error(`tar exited with code ${code}`));
    }
  });
}

async function validateOnly() {
  const registry = await loadRegistryForLocalServer();
  console.log(`Validated ${registry.packs.length} Bench Packs against local manifests.`);
}

async function main() {
  if (process.argv.includes("--validate")) {
    await validateOnly();
    return;
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);

      if (request.method === "GET" && url.pathname === "/registry.json") {
        await serveRegistry(request, response);
        return;
      }

      const packMatch = /^\/packs\/([a-z0-9-]+)\.tar\.gz$/.exec(url.pathname);

      if (request.method === "GET" && packMatch) {
        await servePackArchive(packMatch[1], response);
        return;
      }

      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Registry server failed."
      });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`benchlocal-registry listening on http://${HOST}:${PORT}`);
  });
}

await main();
