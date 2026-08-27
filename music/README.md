# Local music library

Put user-owned or properly licensed MP3 files in mood folders under this directory. The application
only reads these originals.

```text
music/
  calm/example.mp3
  night/example.mp3
  upbeat/example.mp3
  emotional/example.mp3
```

Register each file in `config/music/tracks.json`. Paths are relative to this directory. `durationSec`
may be omitted; when present it is only a hint because the application always measures the MP3 with
ffprobe before using it. License and attribution are user-supplied facts and are never guessed.

```json
{
  "schemaVersion": 2,
  "tracks": [
    {
      "id": "calm-example",
      "path": "calm/example.mp3",
      "mood": ["calm", "acoustic"],
      "energy": 0.35,
      "tags": ["travel"],
      "license": "User supplied",
      "attribution": "Artist name",
      "bpm": null
    }
  ]
}
```
