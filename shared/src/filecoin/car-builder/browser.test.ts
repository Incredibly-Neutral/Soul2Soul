import { describe, it, expect, vi, beforeEach } from 'vitest';
import { browserFilecoinBuilder } from './browser.js';

// The car-builder module imports `createCarFromFile` from
// `filecoin-pin/core/unixfs`, whose "browser" condition exports it but whose
// Node ("default") build does NOT — so under the node test environment the
// named export is undefined. We mock the module and assert the wrapper's
// behavior: it wraps the input bytes in a browser File and forwards to
// createCarFromFile, returning rootCid.toString() + the raw CAR bytes.
const car = vi.hoisted(() => {
  const createCarFromFile = vi.fn();
  return { createCarFromFile };
});

vi.mock('filecoin-pin/core/unixfs', () => ({
  createCarFromFile: car.createCarFromFile,
}));

const FAKE_ROOT_CID = { toString: () => 'bafyRoot' };
const FAKE_CAR = new Uint8Array([0, 1, 2, 3, 4]);

describe('browserFilecoinBuilder', () => {
  beforeEach(() => {
    car.createCarFromFile.mockReset();
  });

  it('wraps the bytes in a browser File named payload.json and calls createCarFromFile', async () => {
    car.createCarFromFile.mockResolvedValue({ rootCid: FAKE_ROOT_CID, carBytes: FAKE_CAR });
    const bytes = new TextEncoder().encode('{"hello":"world"}');

    const result = await browserFilecoinBuilder.buildCarFromBytes(bytes);

    expect(car.createCarFromFile).toHaveBeenCalledTimes(1);
    const [file] = car.createCarFromFile.mock.calls[0];
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('payload.json');
    expect(file.type).toBe('application/json');
    // Same bytes, just re-wrapped.
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it('returns the stringified root CID and the CAR bytes untouched', async () => {
    car.createCarFromFile.mockResolvedValue({ rootCid: FAKE_ROOT_CID, carBytes: FAKE_CAR });

    const result = await browserFilecoinBuilder.buildCarFromBytes(new Uint8Array([9]));

    expect(result.rootCid).toBe('bafyRoot');
    expect(result.carBytes).toBe(FAKE_CAR);
  });

  it('propagates errors from createCarFromFile', async () => {
    car.createCarFromFile.mockRejectedValue(new Error('car build failed'));
    await expect(browserFilecoinBuilder.buildCarFromBytes(new Uint8Array([1]))).rejects.toThrow(
      'car build failed',
    );
  });
});
