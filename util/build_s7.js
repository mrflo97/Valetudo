// Private S7 build. Uses the same ARMv7 low-memory target as upstream.
const {execFileSync} = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.resolve(__dirname, "..");
function run(script, args = [], cwd = root, env = process.env) {
    execFileSync(process.execPath, [script, ...args], {cwd: cwd, env: env, stdio: "inherit"});
}

run(path.join(root, "node_modules/pbjs/cli.js"), ["--es5", "backend/lib/robots/midea/generated/midea_protobufs.js", "assets/protobuf/midea.proto"]);
run(path.join(root, "util/build_openapi_schema.mjs"));
run(path.join(root, "frontend/scripts/build.js"), [], path.join(root, "frontend"));

const revision = execFileSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8"}).trim();
const timestamp = new Date().toISOString();
// Distinct headers let an already-open Web UI detect a newly installed private build.
const metadata = {version: require("../package.json").version + "-s7.2",
    commit: revision + "-s7-" + timestamp.replace(/[^0-9]/g, ""), buildTimestamp: timestamp};
fs.writeFileSync(path.join(root, "backend/lib/res/build_metadata.json"), JSON.stringify(metadata));
run(path.join(root, "node_modules/@yao-pkg/pkg/lib-es5/bin.js"), [
    "--targets", "node22-linuxstatic-armv7", "--compress", "Brotli", "--no-bytecode", "--public-packages", "*",
    "--options", "expose-gc,max-heap-size=34,optimize-for-size,lite-mode,no-regexp-tier-up",
    ".", "--output", "../build/s7/valetudo-s7"
], path.join(root, "backend"), {...process.env, PKG_CACHE_PATH: path.join(root, "build_dependencies/pkg")});
const binary = path.join(root, "build/s7/valetudo-s7");
fs.writeFileSync(binary + ".sha256", crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex") + "  valetudo-s7\n");
fs.writeFileSync(path.join(root, "build/s7/build-info.json"), JSON.stringify(metadata, null, 2) + "\n");
