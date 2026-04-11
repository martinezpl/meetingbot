import fs from "fs";
import puppeteer, { Page, Frame } from "puppeteer";
import { launch, getStream, wss } from "puppeteer-stream";
import { BotConfig, EventCode, WaitingRoomTimeoutError } from "../../src/types";
import { Bot } from "../../src/bot";
import path from "path";

// Constant Selectors
const muteButton = 'button[aria-label="Mute"]';
const stopVideoButton = 'button[aria-label="Stop Video"]';
const joinButton = "button.zm-btn.preview-join-button";
const participantsButton =
  "button.footer-button-base__button.ax-outline.footer-button__button";
const leaveButton = 'button[aria-label="Leave"]';
const declineCookiesButton = 'button[id="onetrust-reject-all-handler"]';
const iAgreeButton = 'button[id="wc_agree1"]';
import { Browser } from "puppeteer";
import { Transform } from "stream";

type Participant = {
  id: string;
  name: string;
  watcherId?: NodeJS.Timeout; // actually a string in browser
};

declare global {
  interface Window {
    registerParticipantSpeaking: (participant: Participant) => void;
    observeSpeech: (node: HTMLElement, participant: Participant) => void;
    checkIfSpeaking: (node: HTMLElement, participant: Participant) => void;
    participants: Participant[];
  }
}

export class ZoomBot extends Bot {
  recordingPath: string;
  contentType: string;
  url: string;
  browser!: Browser;
  page!: Page;
  file!: fs.WriteStream;
  stream!: Transform;
  debugRecordingPath: string;

  private lastActivity: number | undefined = undefined;
  private recordingStartedAt: number = 0;
  private speakerTimeframes: {
    [participantName: string]: [number];
  } = {};

  constructor(
    botSettings: BotConfig,
    onEvent: (eventType: EventCode, data?: any) => Promise<void>
  ) {
    super(botSettings, onEvent);
    this.recordingPath = path.resolve(__dirname, "recording.webm");
    this.contentType = "video/webm";
    this.url = `https://app.zoom.us/wc/${this.settings.meetingInfo.meetingId}/join?fromPWA=1&pwd=${this.settings.meetingInfo.meetingPassword}`;
    this.debugRecordingPath = path.resolve(__dirname, "debug.webm");
  }

  getSpeakerTimeframes(): {
    speakerName: string;
    start: number;
    end: number;
  }[] {
    const processedTimeframes: {
      speakerName: string;
      start: number;
      end: number;
    }[] = [];

    const threshold = 1000;
    for (const [speakerName, timeframesArray] of Object.entries(
      this.speakerTimeframes
    )) {
      let start = timeframesArray[0];
      let end = timeframesArray[0];

      for (let i = 1; i < timeframesArray.length; i++) {
        const currentTimeframe = timeframesArray[i]!;
        if (currentTimeframe - end < threshold) {
          end = currentTimeframe;
        } else {
          if (end - start > 500) {
            processedTimeframes.push({ speakerName, start, end });
          }
          start = currentTimeframe;
          end = currentTimeframe;
        }
      }
      processedTimeframes.push({ speakerName, start, end });
    }
    processedTimeframes.sort((a, b) => a.start - b.start || a.end - b.end);

    return processedTimeframes;
  }

  async screenshot(fName: string = "screenshot.png") {
    try {
      if (!this.page) throw new Error("Page not initialized");
      if (!this.browser) throw new Error("Browser not initialized");

      const screenshot = await this.page.screenshot({
        type: "png",
        encoding: "binary",
      });

      // Save the screenshot to a file
      const screenshotPath = path.resolve(`/tmp/${fName}`);
      fs.writeFileSync(screenshotPath, screenshot);
      console.log(`Screenshot saved to ${screenshotPath}`);
    } catch (e) {
      console.log("Error taking screenshot:", e);
    }
  }

  async checkKicked(): Promise<boolean> {
    //TODO: Implement this
    return false;
  }

  /** Launch browser
   *
   */
  async launchBrowser() {
    // Launch a browser and open the meeting
    this.browser = (await launch({
      executablePath: puppeteer.executablePath(),
      headless: "new",
      protocolTimeout: this.settings.automaticLeave.waitingRoomTimeout,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    })) as unknown as Browser;

    console.log("Browser launched");

    // Create a URL object from the url
    const urlObj = new URL(this.url);

    // Get the default browser context
    const context = this.browser.defaultBrowserContext();

    // Clear permission overrides and set our own to camera and microphone
    // This is to avoid the allow microphone and camera prompts
    context.clearPermissionOverrides();
    context.overridePermissions(urlObj.origin, ["camera", "microphone"]);
    console.log("Turned off camera & mic permissions");

    // Opens a new page in the browser
    this.page = await this.browser.newPage();

    await this.page.setViewport({
      width: 1280, // Set desired width
      height: 800, // Set desired height
    });
  }

  /**
   * Opens a browser and navigatges, joins the meeting.
   * @returns {Promise<void>}
   */
  async joinMeeting() {
    // Launch
    await this.launchBrowser();

    await this.startRecording(true);

    // Create a URL object from the url
    const page = this.page;
    const urlObj = new URL(this.url);

    // Navigates to the url
    console.log("Atempting to open link");
    await page.goto(urlObj.href);
    console.log("Page opened");

    // Waits for the page's iframe to load
    console.log("Wating for iFrame to load");
    const iframe = await page.waitForSelector(".pwa-webclient__iframe");
    const frame = await iframe?.contentFrame();
    console.log("Opened iFrame");

    if (frame) {
      // Wait for things to load (can be removed later in place of a check for a button to be clickable)
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Optionally, there might be a cookies banner that needs to be declined
      try {
        await frame.waitForSelector(declineCookiesButton, { timeout: 5000 });
        await frame.click(declineCookiesButton);
        console.log("Declined cookies");
      } catch (error) {
        console.log("No cookies banner found");
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Optionally, there might be a privacy policy that needs to be accepted
      try {
        await frame.waitForSelector(iAgreeButton, { timeout: 5000 });
        await frame.click(iAgreeButton);
        console.log("Accepted privacy policy");
      } catch (error) {
        console.log("No privacy policy found");
      }

      // Waits for mute button to be clickable and clicks it
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await frame.waitForSelector(muteButton);
      await frame.click(muteButton);
      console.log("Muted");

      // Waits for the input field and types the name from the config
      await frame.waitForSelector("#input-for-name");
      await frame.type(
        "#input-for-name",
        this.settings?.botDisplayName ?? "Meeting Bot"
      );
      console.log("Typed name");

      // Clicks the join button
      await frame.waitForSelector(joinButton);
      await frame.click(joinButton);
      console.log("Joined the meeting");

      // wait for the leave button to appear (meaning we've joined the meeting)
      await new Promise((resolve) => setTimeout(resolve, 1400)); // Needed to wait for the aria-label to be properly attached
      try {
        await frame.waitForSelector(leaveButton, {
          timeout: this.settings.automaticLeave.waitingRoomTimeout,
        });
        // Wait for the leave button to appear and be properly labeled before proceeding
        console.log("Leave button found and labeled, ready to start recording");
      } catch (error) {
        console.error(error);
        // Distinct error from regular timeout
        throw new WaitingRoomTimeoutError("not admitted");
      }

      await this.stopRecording();
    }
  }

  /**
   * Start Recording the meeting.
   */
  async startRecording(debug = false) {
    // Check if the page is initialized
    if (!this.page) throw new Error("Page not initialized");

    // Create the Stream
    this.stream = await getStream(this.page as any, {
      audio: true,
      video: true,
    });

    // Create and Write the recording to a file, pipe the stream to a fileWriteStream
    if (debug) {
      this.file = fs.createWriteStream(this.debugRecordingPath);
    } else {
      this.file = fs.createWriteStream(this.recordingPath);
    }
    this.stream.pipe(this.file);
    this.recordingStartedAt = Date.now();

    console.log("Recording...");
  }

  /**
   * Stop Recording the meeting.
   */
  async stopRecording() {
    // End the recording and close the file
    if (this.stream) this.stream.destroy();
  }

  async run() {
    // Navigate and join the meeting.
    await this.joinMeeting();

    // Ensure browser exists
    if (!this.browser) throw new Error("Browser not initialized");

    if (!this.page) throw new Error("Page is not initialized");

    await this.startRecording();

    const iframe = await this.page.waitForSelector(".pwa-webclient__iframe");
    const frame = await iframe?.contentFrame();

    await new Promise((resolve) => setTimeout(resolve, 7000));
    try {
      await frame?.click(
        "button.zm-btn.zm-btn-legacy.zm-btn--primary.zm-btn__outline--blue"
      );
      console.log("Clicked 'button' dialog");
    } catch (e) {
      // No dialog
      console.log("No blue button dialog found");
    }

    try {
      await frame?.click('button[aria-label="OK"]');
      console.log("Clicked OK dialog");
    } catch (e) {
      console.log("No OK dialog found");
      // No dialog
    }

    try {
      await frame?.waitForSelector(participantsButton, {
        timeout: this.settings.automaticLeave.waitingRoomTimeout,
      });
    } catch (error) {
      console.error(error);
      // Distinct error from regular timeout
      throw new WaitingRoomTimeoutError("not admitted");
    }

    try {
      await frame?.click("button[aria-label='OK']");
    } catch (e) {
      // No dialog
    }

    const registerParticipantSpeaking = (participant: Participant) => {
      this.lastActivity = Date.now();
      const relativeTimestamp = Date.now() - this.recordingStartedAt;
      console.log(
        `Participant ${participant.name} is speaking at ${relativeTimestamp}ms`
      );

      if (!this.speakerTimeframes[participant.name]) {
        this.speakerTimeframes[participant.name] = [relativeTimestamp];
      } else {
        this.speakerTimeframes[participant.name]!.push(relativeTimestamp);
      }
    };

    // Constantly check if the meeting has ended
    const routineChecks = async () => {
      console.log("routine check");
      let endOk = null;
      let isParticipantsButtonThere = true;
      let buttonFailing = false;
      if (frame) {
        console.log("frame found");
        endOk = await frame.$(
          "button.zm-btn.zm-btn-legacy.zm-btn--primary.zm-btn__outline--blue"
        );
        if (endOk) {
          console.log("endOk found");
          await endOk.click();
        }
        const notifClose = await frame.$('i[aria-label="close"]');
        if (notifClose) {
          console.log("notifClose found");
          await notifClose.click();
        }
        const notifClose2 = await frame.$('i[aria-label="Close Medium"]');
        if (notifClose2) {
          console.log("notifClose2 found");
          await notifClose2.click();
        }
        isParticipantsButtonThere = !!(await frame.$(participantsButton));

        let participantSection = await frame.$(
          "div.ReactVirtualized__Grid__innerScrollContainer"
        );
        console.log("participantSection found", participantSection);
        if (!participantSection) {
          try {
            console.log("clicking participants button");
            await frame.click(participantsButton);
            console.log("clicked participants button");
            participantSection = await frame.$(
              "div.ReactVirtualized__Grid__innerScrollContainer"
            );
            console.log("participantSection found");
          } catch (e) {
            console.log("Could not click participants button: ", e);
            buttonFailing = true;
          }
        }
      }

      const participantNodes = await frame?.$$(".item-pos.participants-li");
      if (!participantNodes || participantNodes.length === 0) {
        console.log("No participant nodes found");
      } else {
        console.log("participantNodes found");
        for (const node of participantNodes) {
          console.log("node found");
          const participant = await frame?.evaluate((node) => {
            const participantNode = node as HTMLElement;
            const id = participantNode.id;
            const name =
              participantNode.getAttribute("aria-label")?.split(",")[0] ??
              "Unknown";
            return { id, name };
          }, node);

          console.log("participant found");
          const isSpeaking = await node.$(
            ".participants-icon__voip-speaking-icon"
          );
          if (isSpeaking && participant) {
            // Register that this participant is speaking
            registerParticipantSpeaking(participant);
          }
        }
      }

      let isTimeToFuckOff: boolean;

      if (!buttonFailing) {
        console.log("buttonFailing is false");
        const inactivityTime = this.lastActivity
          ? Date.now() - this.lastActivity
          : Infinity;

        const timeInMeeting = Date.now() - this.recordingStartedAt;

        const isDeadSilence =
          inactivityTime > this.settings.automaticLeave.everyoneLeftTimeout;

        isTimeToFuckOff =
          timeInMeeting > this.settings.automaticLeave.noOneJoinedTimeout &&
          isDeadSilence;
      } else {
        console.log("buttonFailing is true");
        isTimeToFuckOff = false;
      }

      const hasMeetingEnded = !frame || !isParticipantsButtonThere;

      if (hasMeetingEnded || isTimeToFuckOff) {
        console.log(hasMeetingEnded ? "Meeting ended" : "Time to fuck off");

        this.stopRecording();

        await this.endLife();
      } else {
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
    };

    while (true) {
      try {
        await routineChecks();
      } catch (e) {
        console.log("Routine check failed, ending:", e);
        this.stopRecording();
        await this.endLife();
        break;
      }
    }
  }

  // Get the path to the recording file
  getRecordingPath(): string {
    return this.recordingPath;
  }

  // Get the content type of the recording file
  getContentType(): string {
    return this.contentType;
  }

  /**
   * Clean Resources, close the browser.
   * Ensure the filestream is closed as well.
   */
  async endLife() {
    // Ensure Recording is stopped in unideal situations
    this.stopRecording();

    // Close File if it exists
    if (this.file) {
      this.file.close();
      this.file = null as any;
    }

    // Close Browser
    if (this.browser) {
      await this.browser.close();

      // Close the websocket server
      (await wss).close();
    }
  }
}
