import { Telegraf } from "telegraf";
import { AppConfig } from "./config.js";
import { AssistantRepository } from "./db.js";
import { formatTaskList } from "./format.js";
import { MiniMaxClient } from "./minimax.js";
import { runReminderTick } from "./reminders.js";
import { createPendingAction, applyPendingAction } from "./actions.js";
import { endOfLocalDay, startOfLocalDay, startOfNextWeek } from "./time.js";
import { ParsedAction } from "./types.js";

type BotDeps = {
  config: AppConfig;
  repo: AssistantRepository;
  minimax: MiniMaxClient;
};

export function createAssistantBot({ config, repo, minimax }: BotDeps): Telegraf {
  const bot = new Telegraf(config.telegramBotToken);

  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.allowedUserId) {
      await ctx.reply("這個助理目前只接受授權使用者。");
      return;
    }
    await next();
  });

  bot.start((ctx) =>
    ctx.reply(
      [
        "我準備好了。你可以直接用中文丟任務給我。",
        "例如：明天下午前要完成報價單，大概 2 小時，要專心。",
        "我會先給預覽，回 /confirm 才會套用。"
      ].join("\n")
    )
  );

  bot.command("today", async (ctx) => {
    const start = startOfLocalDay(new Date()).toISOString();
    const end = endOfLocalDay(new Date()).toISOString();
    await ctx.reply(formatTaskList(repo.listScheduledBetween(start, end)));
  });

  bot.command("week", async (ctx) => {
    const start = startOfLocalDay(new Date()).toISOString();
    const end = startOfNextWeek(new Date()).toISOString();
    await ctx.reply(formatTaskList(repo.listScheduledBetween(start, end)));
  });

  bot.command("confirm", async (ctx) => {
    const pending = repo.getPendingAction(ctx.chat.id);
    if (!pending) {
      await ctx.reply("目前沒有待確認的變更。");
      return;
    }
    const result = applyPendingAction(repo, pending);
    repo.clearPendingAction(ctx.chat.id);
    await ctx.reply(result);
  });

  bot.command("reject", async (ctx) => {
    repo.clearPendingAction(ctx.chat.id);
    await ctx.reply("已放棄最近一次待確認變更。");
  });

  bot.command("plan", async (ctx) => {
    await handleParsedAction(ctx.chat.id, ctx.reply.bind(ctx), repo, minimax, { intent: "replan", confidence: 1 });
  });

  bot.command("add", async (ctx) => {
    await handleText(ctx.chat.id, ctx.reply.bind(ctx), repo, minimax, commandPayload(ctx.message.text, "/add"));
  });

  bot.command("done", async (ctx) => {
    const target = commandPayload(ctx.message.text, "/done");
    await handleParsedAction(ctx.chat.id, ctx.reply.bind(ctx), repo, minimax, {
      intent: "complete",
      task: { target },
      confidence: 1
    });
  });

  bot.command("move", async (ctx) => {
    await handleText(ctx.chat.id, ctx.reply.bind(ctx), repo, minimax, commandPayload(ctx.message.text, "/move"));
  });

  bot.on("text", async (ctx) => {
    await handleText(ctx.chat.id, ctx.reply.bind(ctx), repo, minimax, ctx.message.text);
  });

  bot.on("photo", async (ctx) => {
    const caption = ctx.message.caption?.trim();
    if (caption) {
      await handleText(ctx.chat.id, ctx.reply.bind(ctx), repo, minimax, caption);
      return;
    }
    await ctx.reply("我收到截圖了，但第一版暫時未支援 OCR 讀圖。請把任務內容用文字傳給我；如果圖片有 caption，我會直接解析 caption。");
  });

  bot.on("document", async (ctx) => {
    await ctx.reply("我收到檔案了。第一版暫時只支援文字任務輸入；請把任務內容貼成文字，我就可以幫你排程。");
  });

  bot.catch((error) => {
    console.error("Telegram bot error", error);
  });

  return bot;
}

export async function handleText(
  chatId: number,
  reply: (message: string) => Promise<unknown>,
  repo: AssistantRepository,
  minimax: MiniMaxClient,
  text: string
): Promise<void> {
  if (!text.trim()) {
    await reply("請告訴我要新增或調整什麼任務。");
    return;
  }

  try {
    const parsed = await minimax.parseUserMessage({
      text,
      now: new Date(),
      activeTasks: repo.listActiveTasks()
    });
    await handleParsedAction(chatId, reply, repo, minimax, parsed, text);
  } catch (error) {
    await reply(error instanceof Error ? error.message : "解析失敗，請再說一次。");
  }
}

export async function handleParsedAction(
  chatId: number,
  reply: (message: string) => Promise<unknown>,
  repo: AssistantRepository,
  minimax: MiniMaxClient,
  parsed: ParsedAction,
  originalText = ""
): Promise<void> {
  try {
    if (parsed.intent === "query_today") {
      const start = startOfLocalDay(new Date()).toISOString();
      const end = endOfLocalDay(new Date()).toISOString();
      await reply(formatTaskList(repo.listScheduledBetween(start, end)));
      return;
    }
    if (parsed.intent === "query_week") {
      const start = startOfLocalDay(new Date()).toISOString();
      const end = startOfNextWeek(new Date()).toISOString();
      await reply(formatTaskList(repo.listScheduledBetween(start, end)));
      return;
    }

    const pending = createPendingAction(repo, parsed);
    repo.savePendingAction(chatId, pending);
    const summary = await minimax.summarizeSchedule({ userText: originalText, preview: pending.preview }).catch(() => pending.preview);
    await reply(summary);
  } catch (error) {
    await reply(error instanceof Error ? error.message : "處理失敗，請再試一次。");
  }
}

export async function sendReminderTick(bot: Telegraf, repo: AssistantRepository, chatId: number): Promise<void> {
  await runReminderTick(repo, chatId, async (targetChatId, message) => {
    await bot.telegram.sendMessage(targetChatId, message);
  });
}

function commandPayload(text: string, command: string): string {
  return text.replace(new RegExp(`^${command}(?:@\\w+)?\\s*`, "i"), "").trim();
}
