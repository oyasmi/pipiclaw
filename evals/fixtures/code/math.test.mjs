import assert from "node:assert/strict";
import { add } from "./math.mjs";

assert.equal(add(2, 3), 5);
console.log("math test passed");
