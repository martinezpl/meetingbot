import fs from "fs";
import puppeteer, { Browser, Page } from "puppeteer";
import { launch, getStream, wss } from "puppeteer-stream";
import { BotConfig, EventCode, WaitingRoomTimeoutError } from "../../src/types";
import { Bot } from "../../src/bot";
import path from "path";
import { Transform } from "stream";

const leaveButtonSelector =
  'button[aria-label="Leave (Ctrl+Shift+H)"], button[aria-label="Leave (⌘+Shift+H)"], button[aria-label="Leave"], button[title="Leave"]';

const joinMeetingOnBrowser =
  'button[aria-label="Join meeting from this browser"]';

export class TeamsBot extends Bot {
  recordingPath: string;
  contentType: string;
  url: string;
  participants: string[];
  participantsIntervalId: NodeJS.Timeout;
  browser!: Browser;
  page!: Page;
  file!: fs.WriteStream;
  stream!: Transform;
  joinedAt: Date | null = null;
  debugRecordingPath: string;

  private maxDuration: number = 1000 * 60 * 180;
  private recordingStartedAt: number = 0;
  private isShuttingDown: boolean = false;

  constructor(
    botSettings: BotConfig,
    onEvent: (eventType: EventCode, data?: any) => Promise<void>
  ) {
    super(botSettings, onEvent);
    this.recordingPath = "./recording.webm";
    this.contentType = "video/webm";
    if (!this.settings.meetingInfo.meetingUrl) {
      this.url = `https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_${this.settings.meetingInfo.meetingId}@thread.v2/0?context=%7b%22Tid%22%3a%22${this.settings.meetingInfo.tenantId}%22%2c%22Oid%22%3a%22${this.settings.meetingInfo.organizerId}%22%7d&anon=true`;
    } else {
      this.url = this.settings.meetingInfo.meetingUrl!;
    }
    this.participants = [];
    this.participantsIntervalId = setInterval(() => {}, 0);
    this.debugRecordingPath = "./debug.webm";
  }

  getRecordingPath(): string {
    return this.recordingPath;
  }

  getContentType(): string {
    return this.contentType;
  }

  getSpeakerTimeframes() {
    return [];
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

  async observeEverybodyLeft(): Promise<any> {
    while (true) {
      if (this.isShuttingDown) return;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      try {
        if (
          this.participants.length <= 1 &&
          this.joinedAt &&
          Date.now() >
            this.joinedAt.getTime() +
              this.settings.automaticLeave.noOneJoinedTimeout
        ) {
          console.log("Everybody left, leaving the meeting");
          return;
        }
        // Check if the bot has been in the meeting for too long (maybe add a setting)
        if (
          this.recordingStartedAt &&
          Date.now() - this.recordingStartedAt > this.maxDuration
        ) {
          console.log("Max Duration Reached");
          return;
        }
      } catch (error: any) {
        if (String(error?.message || error).includes("Target closed")) return;
        console.log("observeEverybodyLeft error:", error);
        return;
      }
    }
  }

  async observeMeetingEnded(): Promise<any> {
    while (true) {
      if (this.isShuttingDown) return;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      try {
        if (!this.page || (this.page as any).isClosed?.() === true) return;
        const leaveButton = await this.page.$(leaveButtonSelector);
        if (!leaveButton) {
          console.log("Meeting ended, leaving the meeting");
          return;
        }
      } catch (error: any) {
        if (String(error?.message || error).includes("Target closed")) return;
        console.log("observeMeetingEnded error:", error);
        return;
      }
    }
  }

  async observeGotKickedOut(): Promise<any> {
    while (true) {
      if (this.isShuttingDown) return;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      try {
        if (!this.page || (this.page as any).isClosed?.() === true) return;
        const h1Elements = await this.page.$$("h1");
        for (const elem of h1Elements) {
          const textContent = await elem.evaluate((el) => el.textContent);
          if (textContent?.trim() === "You've been removed from this meeting") {
            console.log("Kicked out of the meeting");
            return;
          }
        }
      } catch (error: any) {
        if (String(error?.message || error).includes("Target closed")) return;
        console.log("observeGotKickedOut error:", error);
        return;
      }
    }
  }

  async launchBrowser() {
    // Launch the browser and open a new blank page
    this.browser = (await launch({
      executablePath: puppeteer.executablePath(),
      headless: "new",
      // args: ["--use-fake-ui-for-media-stream"],
      args: ["--no-sandbox"],
      protocolTimeout: 0,
    })) as unknown as Browser;

    // Parse the URL
    console.log("Parsing URL:", this.url);
    const urlObj = new URL(this.url);

    // Override camera and microphone permissions
    const context = this.browser.defaultBrowserContext();
    context.clearPermissionOverrides();
    context.overridePermissions(urlObj.origin, ["camera", "microphone"]);

    // Open a new page
    this.page = await this.browser.newPage();
    console.log("Opened Page");
  }

  async joinMeeting() {
    // Navigate the page to a URL
    const urlObj = new URL(this.url);
    console.log("Navigating to URL:", urlObj.href);
    await this.page.goto(urlObj.href);

    // Optionally, there might be a "Join meeting from this browser" button
    try {
      await this.page.waitForSelector(joinMeetingOnBrowser, { timeout: 5000 });
      await this.page.click(joinMeetingOnBrowser);
      console.log("Clicked 'Join meeting from this browser' button");
    } catch (error) {
      console.log("No 'Join meeting from this browser' button found");
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));

    try {
      // Wait for the "Continue without audio or video" button to appear
      await this.page.waitForSelector("#dialog-content-2 > div > button", {
        timeout: 5000,
      });
      await this.page.click("#dialog-content-2 > div > button");
      console.log('Clicked "Continue without audio or video" button');
    } catch (error) {
      console.log("No 'Continue without audio or video' button found");
    }

    // Fill in the display name
    const input = this.page.locator('[data-tid="prejoin-display-name-input"]');
    await input.click(); // focus first

    const name = this.settings.botDisplayName ?? "Meeting Bot";
    for (const char of name) {
      await this.page.keyboard.type(char, {
        delay: Math.floor(Math.random() * (300 - 100 + 1)) + 100,
      });
    }

    console.log("Entered Display Name");

    // Join the meeting
    await this.page.locator(`[data-tid="prejoin-join-button"]`).click();
    console.log("Found & Clicked the Join Button");

    // Wait until join button is disabled or disappears
    try {
      await this.page.waitForFunction(
        (selector) => {
          const joinButton = document.querySelector(selector);
          return !joinButton || joinButton.hasAttribute("disabled");
        },
        {},
        '[data-tid="prejoin-join-button"]'
      );
    } catch (error) {
      console.log("Error waiting for join button to be disabled:", error);
    }

    // Check if we're in a waiting room by checking if the join button exists and is disabled
    const joinButton = await this.page.$('[data-tid="prejoin-join-button"]');
    const isWaitingRoom =
      joinButton &&
      (await joinButton.evaluate((button) => button.hasAttribute("disabled")));

    let timeout = 30000; // if not in the waiting room, wait 30 seconds to join the meeting
    if (isWaitingRoom) {
      console.log(
        `Joined waiting room, will wait for ${
          this.settings.automaticLeave.waitingRoomTimeout > 60 * 1000
            ? `${
                this.settings.automaticLeave.waitingRoomTimeout / 60 / 1000
              } minute(s)`
            : `${
                this.settings.automaticLeave.waitingRoomTimeout / 1000
              } second(s)`
        }`
      );

      // if in the waiting room, wait for the waiting room timeout
      timeout = this.settings.automaticLeave.waitingRoomTimeout; // in milliseconds
    }

    // wait for the leave button to appear (meaning we've joined the meeting)
    console.log(
      "Waiting for the ability to leave the meeting (when I'm in the meeting...)",
      timeout,
      "ms"
    );
    try {
      await this.page.waitForSelector(leaveButtonSelector, {
        timeout: timeout,
      });
    } catch (error) {
      // Distinct error from regular timeout
      console.log("Error waiting for leave button:", error);
      throw new WaitingRoomTimeoutError("not admitted");
    }

    try {
      await this.page.waitForSelector('button[title="Close"]', {
        timeout: 4000,
      });
      await this.page.click('button[title="Close"]');
      console.log("Closed permission popup");
    } catch (error) {
      // Distinct error from regular timeout
      console.log("No permission popup");
    }

    // Log Done
    console.log("Successfully joined meeting");
    this.joinedAt = new Date();
  }

  async startRecording(debug = false) {
    if (!this.page) throw new Error("Page not initialized");

    // Get the stream
    this.stream = await getStream(
      this.page as any, //puppeteer type issue
      { audio: true, video: true }
    );

    // Create a file
    if (debug) {
      this.file = fs.createWriteStream(this.debugRecordingPath);
    } else {
      this.file = fs.createWriteStream(this.getRecordingPath());
    }
    this.stream.pipe(this.file);

    // Pipe the stream to a file
    console.log("Recording...");
  }

  async stopRecording() {
    // Stop recording
    if (this.stream) {
      console.log("Stopping recording...");
      this.stream.destroy();
    }
  }

  async run() {
    await this.launchBrowser();

    await this.startRecording(true);

    this.recordingStartedAt = Date.now();

    // Start Join
    await this.joinMeeting();

    // Click the people button
    console.log("Opening the participants list");
    await this.page.locator('[aria-label="People"]').click();

    // Wait for the attendees tree to appear
    console.log("Waiting for the attendees tree to appear");
    const tree = await this.page.waitForSelector('[role="tree"]');
    console.log("Attendees tree found");

    const updateParticipants = async () => {
      try {
        if (this.isShuttingDown) return "";
        if (!this.page || (this.page as any).isClosed?.() === true) return "";
        const evaluationResult = await this.page.evaluate(() => {
          const participantsList = document.querySelector('[role="tree"]');
          if (!participantsList) {
            console.log("No participants list found");
            return {
              participants: [],
              dom: document.documentElement.outerHTML,
            };
          }

          let currentElements = Array.from(
            participantsList.querySelectorAll(
              '[data-tid^="participantsInCall-"]'
            )
          );
          let participants = [];

          if (currentElements.length === 0) {
            currentElements = Array.from(
              participantsList.querySelectorAll(
                '[data-cid="roster-participant"]'
              )
            );

            participants = currentElements.map((el) => {
              const name = el
                .getAttribute("data-tid")
                ?.replace("attendeesInMeeting-", "");
              return name || "";
            });

            return { participants, dom: document.documentElement.outerHTML };
          }

          participants = currentElements
            .map((el) => {
              const nameSpan = el.querySelector("span[title]");
              return (
                nameSpan?.getAttribute("title") ||
                nameSpan?.textContent?.trim() ||
                ""
              );
            })
            .filter((name) => name);

          return { participants, dom: document.documentElement.outerHTML };
        });

        this.participants = evaluationResult.participants;
        return evaluationResult.dom;
      } catch (error) {
        if (
          String((error as any)?.message || error).includes("Target closed")
        ) {
          return "";
        }
        console.log("Error getting participants:", error);
        return "";
      }
    };

    // Get initial participants list
    const debugHtml = await updateParticipants();
    if (this.participants.length == 0) {
      try {
        fs.writeFileSync("./debug.html", debugHtml, "utf-8");
        console.log(`DOM HTML saved to debug.html`);
      } catch (err) {
        console.error("Error saving DOM HTML:", err);
      }
    }

    // Then check for participants every heartbeatInterval milliseconds
    this.participantsIntervalId = setInterval(
      updateParticipants,
      this.settings.heartbeatInterval
    );

    await this.stopRecording();
    await this.startRecording();

    while (
      this.participants.length <= 1 &&
      this.joinedAt &&
      Date.now() <
        this.joinedAt.getTime() +
          this.settings.automaticLeave.noOneJoinedTimeout
    ) {
      console.log("Waiting for participants to join...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    console.log("Participants joined:", this.participants);

    await Promise.race([
      this.observeEverybodyLeft(),
      this.observeMeetingEnded(),
      this.observeGotKickedOut(),
    ]);

    // Clear the participants checking interval
    clearInterval(this.participantsIntervalId);

    await this.endLife();
  }

  /**
   * Clean Resources, close the browser.
   * Ensure the filestream is closed as well.
   */
  async endLife() {
    console.log("Ending bot life...");
    this.isShuttingDown = true;

    // Clear any intervals or timeouts to prevent open handles
    if (this.participantsIntervalId) {
      clearInterval(this.participantsIntervalId);
    }

    // Stop recording before closing page/browser
    try {
      await this.stopRecording();
    } catch (error) {
      console.log("Error stopping recording:", error);
    }

    // Close File if it exists
    try {
      if (this.file) {
        this.file.close();
        this.file = null as any;
      }
    } catch (error) {
      console.log("Error closing file stream:", error);
    }

    // Attempt to gracefully leave the meeting if page is still open
    try {
      if (this.page && (this.page as any).isClosed?.() !== true) {
        await this.page.click(leaveButtonSelector);
      }
    } catch (error) {
      // Ignore target closed during shutdown
      console.log("Error clicking leave button:", error);
    }

    // Close Browser
    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch (error) {
      console.log("Error closing browser:", error);
    }

    // Close the websocket server
    try {
      (await wss).close();
    } catch (error) {
      console.log("Error closing websocket server:", error);
    }
  }
}
