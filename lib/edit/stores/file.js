// Store: JSON files in a local folder (a client repo checkout, a scratch copy, or tests).
// Doesn't commit; run git yourself afterwards if the folder is a repo.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { StaleError } from "../index.js";

export function fileStore(dir) {
  async function snapshot(files) {
    const out = {};
    const hash = createHash("sha256");
    for (const file of files) {
      let text = null;
      try {
        text = await fs.readFile(path.join(dir, file), "utf8");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      hash.update(`${file}\0${text ?? ""}\0`);
      out[file] = text === null ? null : JSON.parse(text);
    }
    // The head names the files it covers, so write() can re-check exactly those.
    return { files: out, head: `${files.join(",")}:${hash.digest("hex")}` };
  }

  return {
    read: snapshot,
    async write(files, message, head) {
      if ((await snapshot(head.slice(0, head.lastIndexOf(":")).split(","))).head !== head) throw new StaleError();
      for (const [file, data] of Object.entries(files)) {
        const target = path.join(dir, file);
        await fs.writeFile(`${target}.tmp`, JSON.stringify(data, null, 2) + "\n");
        await fs.rename(`${target}.tmp`, target);
      }
      return { message };
    },
  };
}
