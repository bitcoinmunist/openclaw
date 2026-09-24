// Log substring assertion helper for onboard E2E scenarios.
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

// Clack redraws long interactive menus in-place. Keep a bounded window, but large
// enough that the prompt preceding a full terminal redraw burst remains visible.
const DEFAULT_MAX_LOG_BYTES = 1_048_576;
const LOG_SCAN_CHUNK_BYTES = 64 * 1024;

const normalizeScriptOutput = (value) => value.replace(/\r?\n/g, "").replace(/\r/g, "");
const oscPattern = new RegExp(String.raw`\u001b\][^\u0007]*(?:\u0007|\u001b\\)`, "g");
const csiPattern = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");

const stripAnsi = (value) =>
  normalizeScriptOutput(value).replace(oscPattern, "").replace(csiPattern, "");

const compact = (value) =>
  stripAnsi(value)
    .toLowerCase()
    .replace(/[^a-z]+/g, "");

export function readLogTail(file, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive integer");
  }
  const stats = fs.statSync(file);
  if (!stats.isFile()) {
    throw new Error(`${file} is not a file`);
  }
  const length = Math.min(stats.size, maxBytes);
  const start = Math.max(0, stats.size - length);
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function logTailContains(file, needle, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  const compactNeedle = compact(needle);
  if (!compactNeedle) {
    return false;
  }
  return compact(readLogTail(file, maxBytes)).includes(compactNeedle);
}

export function logContains(file, needle) {
  const compactNeedle = compact(needle);
  if (!compactNeedle) {
    return false;
  }
  const stats = fs.statSync(file);
  if (!stats.isFile()) {
    throw new Error(`${file} is not a file`);
  }

  const buffer = Buffer.alloc(LOG_SCAN_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  const fd = fs.openSync(file, "r");
  let ansiState = "plain";
  let compactWindow = "";

  const scan = (text) => {
    for (const character of text) {
      if (ansiState === "osc") {
        if (character === "\u0007") {
          ansiState = "plain";
        } else if (character === "\u001b") {
          ansiState = "osc-escape";
        }
        continue;
      }
      if (ansiState === "osc-escape") {
        ansiState = character === "\\" ? "plain" : "osc";
        continue;
      }
      if (ansiState === "csi") {
        if (character >= "@" && character <= "~") {
          ansiState = "plain";
        }
        continue;
      }
      if (ansiState === "escape") {
        if (character === "[") {
          ansiState = "csi";
          continue;
        }
        if (character === "]") {
          ansiState = "osc";
          continue;
        }
        ansiState = "plain";
      } else if (character === "\u001b") {
        ansiState = "escape";
        continue;
      }

      const lower = character.toLowerCase();
      if (lower < "a" || lower > "z") {
        continue;
      }
      compactWindow = `${compactWindow}${lower}`.slice(-compactNeedle.length);
      if (compactWindow === compactNeedle) {
        return true;
      }
    }
    return false;
  };

  try {
    for (let position = 0; position < stats.size; position += LOG_SCAN_CHUNK_BYTES) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (scan(decoder.write(buffer.subarray(0, bytesRead)))) {
        return true;
      }
    }
    return scan(decoder.end());
  } finally {
    fs.closeSync(fd);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, needle] = process.argv.slice(2);
  if (!file || !needle) {
    process.exit(1);
  }

  try {
    process.exit(logContains(file, needle) ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
