import { chromium } from "playwright-extra";
import { Browser, Page } from "playwright";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { setTimeout } from "timers/promises";
import { BotConfig, EventCode } from "../../src/types";
import { Bot } from "../../src/bot";
import {
  attachMutationObserver,
  dumpPageHTML,
  setupNetworkLogging,
} from "./debugTools";

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
    setParticipantCount: (count: number) => void;
    addParticipantCount: (count: number) => void;
  }
}

export class MeetsBot extends Bot {
  browserArgs: string[];
  meetingURL: string;
  browser!: Browser;
  page!: Page;
  kicked: boolean = false;
  recordingPath: string;
  debug: boolean = process.env.DEBUG === "true";

  private ffmpegProcess: ChildProcessWithoutNullStreams | null = null;
  private participantCount = 0;
  private timeAloneStarted = Infinity;

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
    this.recordingPath = "./recording.mp4";

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

    const vp = { width: 1280, height: 720 };
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

    if (this.debug) {
      setupNetworkLogging(this.page, true);
      await attachMutationObserver(this.page, "body");
    }

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

    const ffmpegArgs = [
      "-thread_queue_size",
      "512",
      "-video_size",
      "1280x720",
      "-framerate",
      "15",
      "-f",
      "x11grab",
      "-i",
      ":99.0",
      "-thread_queue_size",
      "512",
      "-f",
      "pulse",
      "-i",
      "VirtualSink.monitor",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-vsync",
      "2",
      "-y",
      this.getRecordingPath(),
    ];

    this.ffmpegProcess = spawn("ffmpeg", ffmpegArgs);
    console.log("ffmpeg recording started.");

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
    await this.page.waitForSelector(peopleButton);
    await this.page.click(peopleButton);

    await this.page.waitForSelector('[aria-label="Participants"]', {
      state: "visible",
    });

    console.log("Starting Recording");
    await this.startRecording();

    await this.page.exposeFunction(
      "onParticipantJoin",
      async (participantId: string) => {
        await this.onEvent(EventCode.PARTICIPANT_JOIN, { participantId });
      }
    );

    await this.page.exposeFunction(
      "onParticipantLeave",
      async (participantId: string) => {
        await this.onEvent(EventCode.PARTICIPANT_LEAVE, { participantId });
      }
    );

    await this.page.exposeFunction("addParticipantCount", (count: number) => {
      this.participantCount += count;
      console.log("Updated Participant Count:", this.participantCount);
      this.timeAloneStarted =
        this.participantCount === 1 ? Date.now() : Infinity;
    });

    // Add mutation observer for participant list
    // Use in the browser context to monitor for participants joining and leaving
    await this.page.evaluate(() => {
      const peopleList = document.querySelector('[aria-label="Participants"]');
      if (!peopleList) {
        console.error("Could not find participants list element");
        return;
      }

      const initialParticipants = peopleList.querySelectorAll(
        "[data-participant-id]"
      ).length;
      window.addParticipantCount(initialParticipants);

      console.log("Setting up mutation observer on participants list");
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === "childList") {
            mutation.addedNodes.forEach((node: any) => {
              if (
                node.getAttribute &&
                node.getAttribute("data-participant-id")
              ) {
                console.log(
                  "Participant joined:",
                  node.getAttribute("data-participant-id")
                );
                // @ts-ignore
                window.onParticipantJoin(
                  node.getAttribute("data-participant-id")
                );
                window.addParticipantCount(1);
              }
            });
            mutation.removedNodes.forEach((node: any) => {
              if (
                node.getAttribute &&
                node.getAttribute("data-participant-id")
              ) {
                console.log(
                  "Participant left:",
                  node.getAttribute("data-participant-id")
                );
                // @ts-ignore
                window.onParticipantLeave(
                  node.getAttribute("data-participant-id")
                );
                window.addParticipantCount(-1);
              }
            });
          }
        });
      });
      observer.observe(peopleList, { childList: true, subtree: true });
    });

    while (true) {
      if (this.participantCount === 1) {
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

      await setTimeout(5000);
    }

    console.log("Starting End Life Actions ...");
    await this.leaveMeeting();
  }
}
