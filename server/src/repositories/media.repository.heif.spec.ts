import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Colorspace } from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { automock } from 'test/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { decodeHeicMock } = vi.hoisted(() => ({ decodeHeicMock: vi.fn() }));

const buildHeifBuffer = () => {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32BE(24, 0);
  buffer.write('ftyp', 4, 'ascii');
  buffer.write('heic', 8, 'ascii');
  buffer.write('mif1', 16, 'ascii');
  buffer.write('heic', 20, 'ascii');
  return buffer;
};

const newLoggerMock = () =>
  automock(LoggingRepository, { args: [undefined, { getEnv: () => ({}) } as never], strict: false });

vi.mock('heic-decode', () => ({ default: decodeHeicMock }));

vi.mock('sharp', async () => {
  const actual = (await vi.importActual('sharp')) as typeof import('sharp');
  const sharp = ((actual as { default?: typeof import('sharp') }).default ?? actual) as typeof import('sharp');

  const mockedSharp = ((input: Buffer | string, options?: { raw?: object }) => {
    const isHeifBuffer =
      Buffer.isBuffer(input) && input.subarray(4, 12).equals(Buffer.from('ftypheic', 'ascii'));
    const isHeifPath = typeof input === 'string' && input.toLowerCase().endsWith('.heic');

    if (!options?.raw && (isHeifBuffer || isHeifPath)) {
      const error = new Error(
        'heif: Error while loading plugin: Support for this compression format has not been built in (11.6003)',
      );
      const failure = {
        pipelineColorspace: () => failure,
        withIccProfile: () => failure,
        rotate: () => failure,
        flip: () => failure,
        flop: () => failure,
        resize: () => failure,
        extract: () => failure,
        affine: () => failure,
        raw: () => failure,
        toBuffer: () => Promise.reject(error),
        toFile: () => Promise.reject(error),
        metadata: () => Promise.reject(error),
      };

      return failure;
    }

    return sharp(input as Parameters<typeof sharp>[0], options as Parameters<typeof sharp>[1]);
  }) as typeof sharp;

  Object.assign(mockedSharp, sharp);
  return { __esModule: true, default: mockedSharp };
});

describe('MediaRepository HEIF fallback', () => {
  beforeEach(() => {
    decodeHeicMock.mockReset();
  });

  it('falls back to heic-decode when sharp cannot decode a HEIF image', async () => {
    const { MediaRepository } = await import('./media.repository.js');
    const sut = new MediaRepository(newLoggerMock());

    decodeHeicMock.mockResolvedValue({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([255, 0, 0, 255]),
    });

    const result = await sut.decodeImage(buildHeifBuffer(), {
      colorspace: Colorspace.Srgb,
      processInvalidImages: false,
    });

    expect(decodeHeicMock).toHaveBeenCalledOnce();
    expect(Buffer.isBuffer(decodeHeicMock.mock.calls[0][0].buffer)).toBe(true);
    expect(result.info).toMatchObject({ width: 1, height: 1, channels: 4 });
    expect(result.data).toEqual(Buffer.from([255, 0, 0, 255]));
  });

  it('falls back to heic-decode when decoding a HEIF file path', async () => {
    const { MediaRepository } = await import('./media.repository.js');
    const sut = new MediaRepository(newLoggerMock());

    decodeHeicMock.mockResolvedValue({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([255, 0, 0, 255]),
    });

    const tempDir = await fs.mkdtemp(join(tmpdir(), 'immich-heif-'));
    const heifPath = join(tempDir, 'test.HEIC');

    try {
      await fs.writeFile(heifPath, buildHeifBuffer());

      const result = await sut.decodeImage(heifPath, {
        colorspace: Colorspace.Srgb,
        processInvalidImages: false,
      });

      expect(decodeHeicMock).toHaveBeenCalledOnce();
      expect(Buffer.isBuffer(decodeHeicMock.mock.calls[0][0].buffer)).toBe(true);
      expect(result.info).toMatchObject({ width: 1, height: 1, channels: 4 });
      expect(result.data).toEqual(Buffer.from([255, 0, 0, 255]));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rethrows the original sharp error when the HEIF fallback also fails', async () => {
    const { MediaRepository } = await import('./media.repository.js');
    const sut = new MediaRepository(newLoggerMock());

    decodeHeicMock.mockRejectedValue(new Error('fallback failed'));

    await expect(
      sut.decodeImage(buildHeifBuffer(), {
        colorspace: Colorspace.Srgb,
        processInvalidImages: false,
      }),
    ).rejects.toThrow('Support for this compression format has not been built in');
  });
});
