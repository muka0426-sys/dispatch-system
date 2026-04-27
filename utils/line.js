import axios from "axios";

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

export async function pushText(to, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN");
  if (!to) throw new Error("Missing LINE recipient id (to)");

  await axios.post(
    LINE_PUSH_URL,
    {
      to,
      messages: [{ type: "text", text: String(text ?? "") }]
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
