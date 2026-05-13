import axios from "axios";

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

/**
 * @param {string} to
 * @param {Record<string, unknown>} messageObj LINE Messaging API 單則訊息物件（如 text / textV2）
 */
export async function pushMessage(to, messageObj) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN");
  if (!to) throw new Error("Missing LINE recipient id (to)");
  if (!messageObj || typeof messageObj !== "object") {
    throw new Error("pushMessage: messageObj must be a non-null object");
  }

  await axios.post(
    LINE_PUSH_URL,
    {
      to,
      messages: [messageObj]
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      timeout: 10_000
    }
  );
}

export async function pushText(to, text) {
  return pushMessage(to, { type: "text", text: String(text ?? "") });
}
