import { strict as assert } from "node:assert";
import { Byte, Encoder } from "@nuintun/qrcode";
import { qrVersionBits, readQrVersion } from "../src/qr-version.ts";

Deno.test("BCH version hints agree with both copies from an independent encoder", () => {
  for (let version = 7; version <= 40; version++) {
    const qr = new Encoder({ version, level: "M" }).encode(
      new Byte("version test"),
    );
    const bits = qrVersionBits(version), copies: number[][] = [[], []];
    for (let i = 0; i < 18; i++) {
      const x = qr.size - 11 + i % 3, y = Math.floor(i / 3);
      assert.equal(qr.get(x, y), bits[i]);
      assert.equal(qr.get(y, x), bits[i]);
      copies[0].push(1 - qr.get(x, y));
      copies[1].push(1 - qr.get(y, x));
    }
    assert.equal(readQrVersion(copies), version);
    for (const i of [1, 7, 15]) copies[0][i] = 1 - copies[0][i];
    assert.equal(
      readQrVersion([copies[0]]),
      version,
      "correct three flipped bits",
    );
  }
  assert.equal(readQrVersion([new Array(18).fill(1)]), undefined);
  assert.equal(
    readQrVersion([
      qrVersionBits(7).map((v) => 1 - v),
      qrVersionBits(9).map((v) => 1 - v),
    ]),
    undefined,
    "conflicting copies are ambiguous",
  );
});
