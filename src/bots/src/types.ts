export type MeetingInfo = {
  meetingId?: string;
  meetingPassword?: string;
  meetingUrl?: string;
  organizerId?: string;
  tenantId?: string;
  messageId?: string;
  threadId?: string;
  platform?: "zoom" | "teams" | "google";
};

export type AutomaticLeave = {
  waitingRoomTimeout: number;
  noOneJoinedTimeout: number;
  everyoneLeftTimeout: number;
};

export type BotConfig = {
  id: string;
  userId: string;
  meetingInfo: MeetingInfo;
  meetingTitle: string;
  startTime: Date;
  endTime: Date;
  botDisplayName: string;
  botImage?: string;
  heartbeatInterval: number;
  automaticLeave: AutomaticLeave;
  metadata?: Record<string, any>;
  callbackUrl?: string;
};

export enum Status {
  READY_TO_DEPLOY = "READY_TO_DEPLOY",
  DEPLOYING = "DEPLOYING",
  JOINING_CALL = "JOINING_CALL",
  IN_WAITING_ROOM = "IN_WAITING_ROOM",
  IN_CALL = "IN_CALL",
  CALL_ENDED = "CALL_ENDED",
  DONE = "DONE",
  FATAL = "FATAL",
  NOT_ADMITTED = "NOT_ADMITTED",
}

export enum EventCode {
  READY_TO_DEPLOY = Status.READY_TO_DEPLOY,
  DEPLOYING = Status.DEPLOYING,
  JOINING_CALL = Status.JOINING_CALL,
  IN_WAITING_ROOM = Status.IN_WAITING_ROOM,
  NOT_ADMITTED = Status.NOT_ADMITTED,
  IN_CALL = Status.IN_CALL,
  CALL_ENDED = Status.CALL_ENDED,
  DONE = Status.DONE,
  FATAL = Status.FATAL,
  PARTICIPANT_JOIN = "PARTICIPANT_JOIN",
  PARTICIPANT_LEAVE = "PARTICIPANT_LEAVE",
  LOG = "LOG",
}
