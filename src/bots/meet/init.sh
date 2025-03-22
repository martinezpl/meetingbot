#!/bin/bash

# Start pulseaudio in the background with infinite idle time
pulseaudio --start --exit-idle-time=-1

# Give it a moment to initialize
sleep 2

# Set the sink so that browser audio gets routed to it
export PULSE_SINK=VirtualSink

# Load the null sink for audio routing
pactl load-module module-null-sink sink_name=$PULSE_SINK

# Start virtual display
export DISPLAY=:99
Xvfb $DISPLAY -screen 0 1280x720x24 &

# Start the application
pnpm run start
