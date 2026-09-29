`sample.webm` is a two-second synthetic video for browser playback/seek tests.
It contains no audio and needs no runtime video dependency. Regenerate with:

```sh
ffmpeg -f lavfi -i testsrc2=size=160x90:rate=10 -t 2 -an -c:v libvpx -b:v 60k -y sample.webm
```
