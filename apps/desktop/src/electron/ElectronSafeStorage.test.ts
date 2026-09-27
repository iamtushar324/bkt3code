import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { beforeEach, vi } from "vite-plus/test";

const {
  decryptStringAsyncMock,
  decryptStringMock,
  encryptStringAsyncMock,
  encryptStringMock,
  isAsyncEncryptionAvailableMock,
  isEncryptionAvailableMock,
} = vi.hoisted(() => ({
  decryptStringAsyncMock: vi.fn(),
  decryptStringMock: vi.fn(),
  encryptStringAsyncMock: vi.fn(),
  encryptStringMock: vi.fn(),
  isAsyncEncryptionAvailableMock: vi.fn(),
  isEncryptionAvailableMock: vi.fn(),
}));

vi.mock("electron", () => ({
  safeStorage: {
    decryptString: decryptStringMock,
    decryptStringAsync: decryptStringAsyncMock,
    encryptString: encryptStringMock,
    encryptStringAsync: encryptStringAsyncMock,
    getSelectedStorageBackend: vi.fn(),
    isAsyncEncryptionAvailable: isAsyncEncryptionAvailableMock,
    isEncryptionAvailable: isEncryptionAvailableMock,
  },
}));

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

describe("ElectronSafeStorage", () => {
  beforeEach(() => {
    decryptStringAsyncMock.mockReset();
    decryptStringMock.mockReset();
    encryptStringAsyncMock.mockReset();
    encryptStringMock.mockReset();
    isAsyncEncryptionAvailableMock.mockReset();
    isEncryptionAvailableMock.mockReset();
  });

  it.effect("uses asynchronous encryption APIs and preserves the key-rotation signal", () =>
    Effect.gen(function* () {
      isAsyncEncryptionAvailableMock.mockResolvedValue(true);
      encryptStringAsyncMock.mockResolvedValue(Buffer.from("ciphertext"));
      decryptStringAsyncMock.mockResolvedValue({ result: "plaintext", shouldReEncrypt: true });

      const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
      assert.isTrue(yield* safeStorage.isEncryptionAvailable);
      assert.deepEqual(yield* safeStorage.encryptString("plaintext"), Buffer.from("ciphertext"));
      assert.deepEqual(yield* safeStorage.decryptStringWithMetadata(new Uint8Array([1])), {
        value: "plaintext",
        shouldReEncrypt: true,
      });
      assert.equal(yield* safeStorage.decryptString(new Uint8Array([1])), "plaintext");
      assert.equal(isEncryptionAvailableMock.mock.calls.length, 0);
      assert.equal(encryptStringMock.mock.calls.length, 0);
      assert.equal(decryptStringMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronSafeStorage.layer)),
  );

  it.effect("yields while a Keychain decrypt is pending and maps rejection", () =>
    Effect.gen(function* () {
      let release!: (value: { result: string; shouldReEncrypt: boolean }) => void;
      decryptStringAsyncMock.mockImplementationOnce(
        () =>
          new Promise<{ result: string; shouldReEncrypt: boolean }>((resolve) => {
            release = resolve;
          }),
      );
      const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
      const pending = yield* safeStorage
        .decryptString(new Uint8Array([1]))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      assert.isUndefined(yield* Effect.sync(() => pending.pollUnsafe()));
      assert.isTrue(release !== undefined);
      release({ result: "plaintext", shouldReEncrypt: false });
      assert.equal(yield* Fiber.join(pending), "plaintext");

      decryptStringAsyncMock.mockRejectedValueOnce(new Error("keychain unavailable"));
      const error = yield* safeStorage.decryptString(new Uint8Array([2])).pipe(Effect.flip);
      assert.instanceOf(error, ElectronSafeStorage.ElectronSafeStorageDecryptError);
    }).pipe(Effect.provide(ElectronSafeStorage.layer), Effect.scoped),
  );
});
