# Media scanner fixtures

- `official-sample.heic` is the public HEIC test image used by
  [`heic-convert`](https://github.com/catdad-experiments/heic-convert). It is
  included to exercise the real HEIC-to-JPEG decoder path.
- JPEG and video fixtures are generated in a temporary directory during the
  integration test. The JPEGs contain real EXIF date, offset, GPS, and
  orientation tags. The videos contain real QuickTime/MP4 timestamps and a
  rotation matrix.

Generated artifacts never touch the user's source media and are removed after
each test.
