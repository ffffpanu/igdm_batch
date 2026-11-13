#!/bin/sh
# Merges X_video.mp4 + X_audio.m4a -> X.mp4 (needs ffmpeg). Run inside your Downloads/Instagram folder.
find . -name '*_video.mp4' | while read -r v; do
  a="${v%_video.mp4}_audio.m4a"; o="${v%_video.mp4}.mp4"
  [ -f "$a" ] && ffmpeg -y -loglevel error -i "$v" -i "$a" -c copy "$o" && echo "Merged $o"
done
