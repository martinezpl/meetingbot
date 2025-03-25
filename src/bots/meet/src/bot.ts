import { chromium } from "playwright-extra";
import { Browser, Page } from "playwright";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { setTimeout } from "timers/promises";
import { BotConfig, EventCode } from "../../src/types";
import { Bot } from "../../src/bot";
import { dumpPageHTML } from "./debugTools";

// Use Stealth Plugin to avoid detection
const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete("iframe.contentWindow");
stealthPlugin.enabledEvasions.delete("media.codecs");
chromium.use(stealthPlugin);

// User Agent Constant -- set Feb 2025
const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

const enterNameField = 'input[type="text"][aria-label="Your name"]';
const askToJoinButton = '//button[.//span[text()="Ask to join"]]';
const gotKickedDetector = '//button[.//span[text()="Return to home screen"]]';
const leaveButton = `//button[@aria-label="Leave call"]`;
const peopleButton = `//button[@aria-label="People"]`;

type Participant = {
  id: string;
  name: string;
};

/**
 * @param amount Milliseconds
 * @returns Random Number within 10% of the amount given, mean at amount
 */
const randomDelay = (amount: number) =>
  (2 * Math.random() - 1) * (amount / 10) + amount;

/**
 * Ensure Typescript doesn't complain about the global exposed
 * functions that will be setup in the bot.
 */
declare global {
  interface Window {
    addParticipant: (participant: Participant) => void;
    onParticipantJoin: (participant: Participant) => void;
    onParticipantLeave: (participant: Participant) => void;
    registerParticipantStates: (
      participantStates: { participant: Participant; isSpeaking: boolean }[]
    ) => void;
    debugMutationLog: (mutationData: any) => void;
    isDebug: () => boolean;
  }
}

export class MeetsBot extends Bot {
  browserArgs: string[];
  meetingURL: string;
  browser!: Browser;
  page!: Page;
  kicked: boolean = false;
  recordingPath: string;
  debug: boolean;

  private ffmpegProcess: ChildProcessWithoutNullStreams | null = null;
  private participants: Participant[] = [];
  private speakerTimeframes: {
    [participantName: string]: [[number, number?]];
  } = {};
  private timeAloneStarted = Infinity;
  private lastActivity: number | undefined = undefined;
  private joinedAt: number = 0;
  private maxDuration: number = 75 * 60 * 1000;

  /**
   *
   * @param botSettings Bot Settings as Passed in the API call.
   * @param onEvent Connection to Backend
   */
  constructor(
    botSettings: BotConfig,
    onEvent: (eventType: EventCode, data?: any) => Promise<void>
  ) {
    super(botSettings, onEvent);
    this.debug = process.env.DEBUG ? true : false;
    console.log("Debug Mode is ", this.debug ? "ON" : "OFF");
    this.recordingPath = this.debug
      ? `/debugdir/recording-${botSettings.id}.mp4`
      : `./recording.mp4`;

    this.browserArgs = [
      "--incognito",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-infobars",
      "--use-fake-ui-for-media-stream", // automatically grants screen sharing permissions without a selection dialog.
      "--use-file-for-fake-video-capture=/dev/null",
      "--use-file-for-fake-audio-capture=/dev/null",
      '--auto-select-desktop-capture-source="Chrome"', // record the first tab automatically
      "--autoplay-policy=no-user-gesture-required",
      "--enable-audio-output",
    ];

    this.meetingURL = botSettings.meetingInfo.meetingUrl!;
  }

  getRecordingPath(): string {
    return this.recordingPath;
  }

  getSpeakerTimeframes(): { [participantName: string]: [[number, number?]] } {
    return this.speakerTimeframes;
  }

  getContentType(): string {
    return "video/mp4";
  }

  async run(): Promise<void> {
    await this.joinMeeting();
    await this.meetingActions();
  }

  async joinMeeting() {
    console.log("Joining Call ...");

    this.browser = await chromium.launch({
      headless: false,
      args: this.browserArgs,
    });

    const vp = { width: 1280, height: 1024 };
    const context = await this.browser.newContext({
      permissions: ["camera", "microphone"],
      userAgent,
      viewport: vp,
    });

    this.page = await context.newPage();

    // Pass console logs to the main process for observability
    this.page.on("console", (msg) => {
      console.log(`[BROWSER][${msg.type()}] ${msg.text()}`);
    });

    await this.page.waitForTimeout(randomDelay(1000));

    // Inject anti-detection code using addInitScript
    await this.page.addInitScript(() => {
      // Disable navigator.webdriver to avoid detection
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });

      // Override navigator.plugins to simulate real plugins
      Object.defineProperty(navigator, "plugins", {
        get: () => [
          { name: "Chrome PDF Plugin" },
          { name: "Chrome PDF Viewer" },
        ],
      });

      // Override navigator.languages to simulate real languages
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });

      // Override properties with fake values
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 4 });
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
      Object.defineProperty(window, "innerWidth", { get: () => 1920 });
      Object.defineProperty(window, "innerHeight", { get: () => 1080 });
      Object.defineProperty(window, "outerWidth", { get: () => 1920 });
      Object.defineProperty(window, "outerHeight", { get: () => 1080 });
    });

    const name = this.settings.botDisplayName || "MeetingBot";

    // Go to the meeting URL (Simulate Movement)
    await this.page.mouse.move(10, 672);
    await this.page.mouse.move(102, 872);
    await this.page.mouse.move(114, 1472);
    await this.page.waitForTimeout(300);
    await this.page.mouse.move(114, 100);
    await this.page.mouse.click(100, 100);
    await this.page.goto(this.meetingURL, { waitUntil: "networkidle" });
    await this.page.bringToFront();

    console.log("Waiting for the input field to be visible...");
    await this.page.waitForSelector(enterNameField);
    await this.page.waitForTimeout(randomDelay(1000));

    console.log("Filling the input field with the name...");
    await this.page.fill(enterNameField, name);

    console.log('Waiting for the "Ask to join" button...');
    await this.page.waitForSelector(askToJoinButton, { timeout: 60000 });
    await this.page.click(askToJoinButton);
    console.log("Awaiting Entry...");
    const timeout = this.settings.automaticLeave.waitingRoomTimeout;
    try {
      await this.page.waitForSelector(leaveButton, { timeout });
    } catch {
      // Timeout Error: Will get caught by bot/index.ts
      throw { message: "Bot was not admitted into the meeting." };
    }

    if (this.debug) await dumpPageHTML(this.page, "joined");

    console.log("Joined Call.");
    await this.onEvent(EventCode.JOINING_CALL);
  }

  /**
   * Starts recording the screen and system audio using `ffmpeg`.
   *
   * This method spawns a child `ffmpeg` process that captures the virtual X display (`:99.0`)
   * and the system audio output via PulseAudio's `VirtualSink.monitor`.
   *
   * The recording is saved to `./output.mp4` and continues until `stopRecording()` is called.
   *
   * This approach avoids limitations of browser-based `MediaRecorder`, ensuring
   * reliable capture of both video and real-time audio even inside containerized environments.
   *
   * If recording is already in progress, the method is a no-op.
   */
  async startRecording(): Promise<void> {
    if (this.ffmpegProcess) {
      console.warn("Recording already started.");
      return;
    }

    console.log("Starting ffmpeg recording...");

    const videoInputFormat = "x11grab";
    const audioInputFormat = "pulse";
    const videoSource = ":99.0";
    const audioSource = "VirtualSink.monitor";
    const audioBitrate = "128k";
    const fps = "15";

    const ffmpegArgs = [
      "-thread_queue_size",
      "512",
      "-video_size",
      "1280x1024",
      "-framerate",
      fps,
      "-f",
      videoInputFormat,
      "-i",
      videoSource,
      "-thread_queue_size",
      "512",
      "-f",
      audioInputFormat,
      "-i",
      audioSource,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p", // Required for compatibility with browser players
      "-preset",
      "medium",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      audioBitrate,
      "-vsync",
      "2",
      "-vf",
      "crop=1280:914:0:110",
      "-y",
      this.getRecordingPath(),
    ];

    this.ffmpegProcess = spawn("ffmpeg", ffmpegArgs);
    console.log("ffmpeg recording started.");

    // This may be too noisy
    this.ffmpegProcess.stdout.on("data", (data) => {
      console.log(`ffmpeg: ${data}`);
    });

    this.ffmpegProcess.stderr.on("data", (data) => {
      console.error(`ffmpeg: ${data}`);
    });

    this.ffmpegProcess.on("exit", (code) => {
      console.log(`ffmpeg process exited with code ${code}`);
      this.ffmpegProcess = null;
    });
  }

  /**
   * Stops the ongoing `ffmpeg` recording process and finalizes the output file.
   *
   * Sends a `SIGINT` signal to the `ffmpeg` process to allow it to gracefully
   * finish encoding and close the output file. Waits for the process to exit
   * before resolving.
   *
   * If no recording is active, this method logs a warning and exits silently.
   *
   * After stopping, the recording will be available at the path defined by `this.outputPath`.
   */
  async stopRecording(): Promise<void> {
    if (!this.ffmpegProcess) {
      console.warn("No recording process to stop.");
      return;
    }

    console.log("Stopping ffmpeg recording...");
    // Send SIGINT to allow ffmpeg to finalize the file
    this.ffmpegProcess.kill("SIGINT");

    // Wait for process to exit
    await new Promise((resolve) => {
      this.ffmpegProcess?.on("exit", resolve);
    });

    this.ffmpegProcess = null;
    console.log(`Recording saved to: ${this.getRecordingPath()}`);
  }

  async leaveMeeting() {
    console.log("Stopping Recording ...");
    await this.stopRecording();
    console.log("Recording stopped.");

    try {
      console.log("Trying to leave the call ...");
      await this.page.click(leaveButton, { timeout: 1000 });
      console.log("Left Call.");
    } catch {
      console.log(
        "Attempted to Leave Call - couldn't (probably already left)."
      );
    }

    await this.browser.close();
    console.log("Closed Browser.");
  }

  async meetingActions() {
    // await this.page.waitForSelector(peopleButton);
    // await this.page.click(peopleButton);

    // await this.page.waitForSelector('[aria-label="Participants"]', {
    //   state: "visible",
    // });

    // Wait for participant rectangles to load
    await this.page.waitForSelector('div[class="oZRSLe"]');

    console.log("Starting Recording");
    await this.startRecording();
    this.joinedAt = Date.now();

    await this.page.exposeFunction(
      "onParticipantJoin",
      async (participant: Participant) => {
        this.participants.push(participant);
        await this.onEvent(EventCode.PARTICIPANT_JOIN, participant);
      }
    );

    await this.page.exposeFunction(
      "onParticipantLeave",
      async (participant: Participant) => {
        await this.onEvent(EventCode.PARTICIPANT_LEAVE, participant);
        this.participants = this.participants.filter(
          (p) => p.id !== participant.id
        );
        this.timeAloneStarted =
          this.participants.length === 1 ? Date.now() : Infinity;
      }
    );

    await this.page.exposeFunction(
      "registerParticipantStates",
      async (
        participantStates: { participant: Participant; isSpeaking: boolean }[]
      ) => {
        // Check whether a participant has joined or left
        if (participantStates.length > this.participants.length) {
          console.log("New participant joined");
          this.participants.push(
            participantStates.find(
              (ps) => !this.participants.find((p) => p.id === ps.participant.id)
            )!.participant
          );
        } else if (participantStates.length < this.participants.length) {
          console.log("Participant left");
          this.participants = this.participants.filter((p) =>
            participantStates.find((ps) => ps.participant.id === p.id)
          );
          this.timeAloneStarted =
            this.participants.length <= 1 ? Date.now() : Infinity;
        }

        // Check whether a participant is speaking
        participantStates.forEach(async (state) => {
          const relativeTimestamp = Date.now() - this.joinedAt;
          if (state.isSpeaking) {
            this.lastActivity = Date.now();
            if (!this.speakerTimeframes[state.participant.name]) {
              this.speakerTimeframes[state.participant.name] = [
                [relativeTimestamp],
              ];
            } else {
              const latestTimeframe =
                this.speakerTimeframes[state.participant.name]!.at(-1)!;

              if (latestTimeframe.length === 2) {
                // Latest timeframe is completed, create a new timeframe
                this.speakerTimeframes[state.participant.name]!.push([
                  relativeTimestamp,
                ]);
              }
            }
          } else if (!state.isSpeaking) {
            if (this.speakerTimeframes[state.participant.name]) {
              const latestTimeframe =
                this.speakerTimeframes[state.participant.name]!.at(-1)!;
              if (latestTimeframe.length === 1) {
                // participant stopped speaking, complete the timeframe
                latestTimeframe.push(relativeTimestamp);
              }
            }
          }
        });
      }
    );

    await this.page.exposeFunction(
      "addParticipant",
      async (participant: Participant) => {
        this.participants.push(participant);
      }
    );

    // Use in the browser context to monitor for participants joining, speaking and leaving
    await this.page.evaluate(() => {
      const participantRectangleSelector = 'div[class="oZRSLe"]';
      const participantActivityBorderSelector =
        'div[class="tC2Wod ACcyyc t9yCsb kssMZb"]';
      const participantRectangles = document.querySelectorAll(
        participantRectangleSelector
      );
      if (!participantRectangles) {
        console.error("Could not find any participant rectangles");
        return;
      }

      // Add existing participants to the list
      participantRectangles.forEach((node: any) => {
        console.log("Adding existing participant");
        const participantId = node.getAttribute("data-participant-id")!;
        const participantName =
          node.querySelector("span.notranslate")?.textContent || "Unknown";
        window.addParticipant({ id: participantId, name: participantName });
      });

      setInterval(() => {
        const participantRectangles = document.querySelectorAll(
          participantRectangleSelector
        );
        const participantStates = Array.from(participantRectangles).map(
          (node: any) => {
            const participantId = node.getAttribute("data-participant-id")!;
            const participantName =
              node.querySelector("span.notranslate")?.textContent || "Unknown";
            const isSpeaking = node.querySelector(
              participantActivityBorderSelector
            );
            return {
              participant: { id: participantId, name: participantName },
              isSpeaking,
            };
          }
        );
        window.registerParticipantStates(participantStates);
      }, 500);
    });

    while (true) {
      console.log(this.speakerTimeframes);
      this.participants.forEach((p) => console.log(p.id, p.name));
      if (this.participants.length === 1) {
        const leaveMs = this.settings.automaticLeave.everyoneLeftTimeout;
        const msDiff = Date.now() - this.timeAloneStarted;
        console.log(
          `Only me left in the meeting. Waiting for timeout time to have allocated (${
            msDiff / 1000
          } / ${leaveMs / 1000}s) ...`
        );
        if (msDiff > leaveMs) {
          console.log(
            "Only one participant remaining for timeout duration, leaving."
          );
          break;
        }
      }

      if (
        (await this.page
          .locator(gotKickedDetector)
          .count()
          .catch(() => 0)) > 0 ||
        (await this.page
          .locator(leaveButton)
          .isHidden({ timeout: 500 })
          .catch(() => true)) ||
        (await this.page
          .locator('text="You\'ve been removed from the meeting"')
          .isVisible({ timeout: 500 })
          .catch(() => false))
      ) {
        this.kicked = true;
        console.log("Kicked");
        break;
      }

      // Check if the bot has been in the meeting for too long (maybe add a setting)
      if (Date.now() - this.joinedAt > this.maxDuration) {
        console.log("Max Duration Reached");
        break;
      }

      // Check if there has been no activity for 5 minutes, case for when only bots stay in the meeting
      if (this.lastActivity && Date.now() - this.lastActivity > 300000) {
        console.log("No Activity for 5 minutes");
        break;
      }

      await setTimeout(5000);
    }

    console.log("Starting End Life Actions ...");
    await this.leaveMeeting();
  }
}
