import cron from "node-cron";
import { loadConfig } from "./config.js";
import { AssistantRepository } from "./db.js";
import { MiniMaxClient } from "./minimax.js";
import { createAssistantBot, sendReminderTick } from "./bot.js";
import { startDashboardServer } from "./dashboard.js";
import { runDailyBriefTick } from "./dailyBrief.js";

const config = loadConfig();
const repo = new AssistantRepository(config.databasePath);
const minimax = new MiniMaxClient(config);
const bot = createAssistantBot({ config, repo, minimax });
const dashboard = startDashboardServer(repo, config.dashboardPort);

cron.schedule("* * * * *", () => {
  sendReminderTick(bot, repo, config.allowedUserId).catch((error) => {
    console.error("Reminder tick failed", error);
  });
  runDailyBriefTick(
    repo,
    config.allowedUserId,
    async (chatId, message) => {
      await bot.telegram.sendMessage(chatId, message);
    },
    config.dailyBriefTime
  ).catch((error) => {
    console.error("Daily brief failed", error);
  });
});

bot.launch().then(() => {
  console.log("Assistant bot is running.");
  console.log(`Dashboard is running at http://localhost:${config.dashboardPort}`);
});

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

function shutdown(signal: "SIGINT" | "SIGTERM"): void {
  dashboard.close();
  bot.stop(signal);
  repo.close();
}
