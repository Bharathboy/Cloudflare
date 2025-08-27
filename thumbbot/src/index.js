import TelegramBot from 'telegram-webhook-js';

// In-memory store for the multi-step "set new cover" process
const userState = new Map();

// The main entry point for the ES Module Worker
export default {
	async fetch(request, env, ctx) {
		try {
			if (!env.BOT_TOKEN || !env.COVERS_KV) {
				return new Response('Required environment variables (BOT_TOKEN, COVERS_KV) are not set', { status: 500 });
			}
			const bot = new TelegramBot(env.BOT_TOKEN);
			const url = new URL(request.url);

			if (url.pathname === '/webhook') {
				const update = await request.json();
				// Pass the KV namespace (env.COVERS_KV) to the handler
				ctx.waitUntil(handleUpdate(update, bot, env.COVERS_KV));
				return new Response('OK', { status: 200 });
			}
			if (url.pathname === '/delete') {
				const result = await bot.deleteWebhook();
				return new Response(`Webhook deletion result: ${JSON.stringify(result)}`);
			}
			const webhookUrl = `https://${url.hostname}/webhook`;
			const result = await bot.setWebhook(webhookUrl);
			return new Response(`Webhook set to ${webhookUrl}. Result: ${JSON.stringify(result)}`);
		} catch (err) {
			console.error(err);
			return new Response(err.stack, { status: 500 });
		}
	},
};

// Main handler for all incoming Telegram updates
async function handleUpdate(update, bot, coversKV) {
	if (update.callback_query) {
		await handleCallback(update.callback_query, bot, coversKV);
	} else if (update.message) {
		await handleMessage(update.message, bot, coversKV);
	}
}

// Handles regular messages (text, video, photos)
async function handleMessage(message, bot, coversKV) {
	const chatId = message.chat.id;
	const userId = message.from.id;

	// Handle the new /set_cover command
	if (message.text && message.text.trim() === '/set_cover' && message.reply_to_message && message.reply_to_message.photo) {
		const photo = message.reply_to_message.photo;
		const cover_file_id = photo[photo.length - 1].file_id; // Get highest resolution
		await coversKV.put(String(userId), cover_file_id);
		await bot.sendMessage(chatId, '✅ Cover saved successfully!', { reply_to_message_id: message.message_id });
		return;
	}

	if (message.text && message.text.trim() === '/start') {
		await bot.sendMessage(chatId, 'Hello! Send me a video to get started. You can save a default cover by replying to an image with /set_cover.');
	} else if (message.video) {
		// Check if the user has a saved cover in the KV store
		const savedCover = await coversKV.get(String(userId));

		const inline_keyboard = [
			[
				{ text: 'Extract Cover & Thumbnail', callback_data: 'extract_media' },
				{ text: 'Set New Cover', callback_data: 'set_cover' },
			],
		];

		// Add the "Set Saved Cover" button only if one exists
		if (savedCover) {
			inline_keyboard[0].push({ text: 'Set Saved Cover', callback_data: 'set_saved_cover' });
		}

		await bot.sendMessage(chatId, 'What would you like to do with this video?', {
			reply_to_message_id: message.message_id,
			reply_markup: { inline_keyboard },
		});
	} else if (message.photo) {
		// This logic handles the "Set New Cover" flow (temporary, one-time cover)
		if (userState.has(userId)) {
			const { video_file_id, original_caption, message_id } = userState.get(userId);
			const new_cover_file_id = message.photo[message.photo.length - 1].file_id;

			await bot.deleteMessage(chatId, message.message_id);
			await bot.deleteMessage(chatId, message_id);
			const workingMsg = await bot.sendMessage(chatId, 'Applying new cover and sending video...');

			await bot.sendVideo(chatId, video_file_id, {
				cover: new_cover_file_id,
				caption: original_caption,
			});

			await bot.deleteMessage(chatId, workingMsg.result.message_id);
			userState.delete(userId);
		}
	}
}

// Handles clicks from inline buttons
async function handleCallback(callback_query, bot, coversKV) {
	const action = callback_query.data;
	const message = callback_query.message;
	const original_video_message = message.reply_to_message;
	const chatId = message.chat.id;
	const userId = callback_query.from.id;

	await bot.answerCallbackQuery(callback_query.id);

	if (!original_video_message || !original_video_message.video) {
		await bot.editMessageText(chatId, message.message_id, 'Sorry, the original video could not be found.');
		return;
	}

	const video = original_video_message.video;
	const original_caption = original_video_message.caption;

	if (action === 'extract_media') {
		await bot.editMessageText(chatId, message.message_id, 'Extracting media...');
		let foundMedia = false;

		if (video.cover && Array.isArray(video.cover) && video.cover.length > 0) {
			const cover = video.cover[video.cover.length - 1];
			await bot.sendPhoto(chatId, cover.file_id, { caption: 'Video Cover' });
			foundMedia = true;
		}

		if (video.thumbnail) {
			const fileInfo = await bot.getFile(video.thumbnail.file_id);
			if (fileInfo && fileInfo.file_path) {
				const thumbUrl = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;
				const thumbResponse = await fetch(thumbUrl);
				const thumbBlob = await thumbResponse.blob();
				await bot.sendPhoto(chatId, thumbBlob, { caption: 'Video Thumbnail' });
				foundMedia = true;
			}
		}

		if (foundMedia) {
			await bot.deleteMessage(chatId, message.message_id);
		} else {
			await bot.editMessageText(chatId, message.message_id, 'This video does not have a cover or a thumbnail.');
		}
	} else if (action === 'set_cover') {
		userState.set(userId, {
			video_file_id: video.file_id,
			original_caption: original_caption,
			message_id: message.message_id,
		});
		await bot.editMessageText(chatId, message.message_id, 'Please send me the new image you would like to use as a cover.');
	} else if (action === 'set_saved_cover') {
		const saved_cover_file_id = await coversKV.get(String(userId));
		if (!saved_cover_file_id) {
			await bot.editMessageText(chatId, message.message_id, "You don't have a saved cover. Reply to an image with /set_cover to save one.");
			return;
		}

		await bot.editMessageText(chatId, message.message_id, 'Applying your saved cover...');
		await bot.sendVideo(chatId, video.file_id, {
			cover: saved_cover_file_id,
			caption: original_caption,
		});
		await bot.deleteMessage(chatId, message.message_id);
	}
}