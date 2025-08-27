// A corrected, self-contained TelegramBot class to fix the library's bug
class TelegramBot {
	constructor(token) {
		this.token = token;
		this.apiUrl = `https://api.telegram.org/bot${token}/`;
	}

	async apiCall(method, params) {
		try {
			const response = await fetch(`${this.apiUrl}${method}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(params),
			});
			return await response.json();
		} catch (error) {
			console.error(`Error in ${method}:`, error);
			return { ok: false, description: error.message };
		}
	}

	async setWebhook(url) { return this.apiCall('setWebhook', { url }); }
	async deleteWebhook() { return this.apiCall('deleteWebhook', {}); }
	
    // --- THIS IS THE FIXED METHOD ---
	async sendMessage(chatId, text, options = {}) {
        // The library used camelCase (e.g., replyToMessageId), which was wrong.
        // This version uses the correct snake_case parameters that the Telegram API expects.
		return this.apiCall('sendMessage', {
			chat_id: chatId,
			text,
			parse_mode: options.parse_mode,
			disable_web_page_preview: options.disable_web_page_preview,
			disable_notification: options.disable_notification,
			reply_to_message_id: options.reply_to_message_id,
			reply_markup: options.reply_markup,
		});
	}

	async editMessageText(chatId, messageId, text, options = {}) { return this.apiCall('editMessageText', { chat_id: chatId, message_id: messageId, text, ...options }); }
	async deleteMessage(chatId, messageId) { return this.apiCall('deleteMessage', { chat_id: chatId, message_id: messageId }); }
	async getFile(file_id) {
		const data = await this.apiCall('getFile', { file_id });
		return data.ok ? data.result : null;
	}
	async answerCallbackQuery(callback_query_id, options = {}) { return this.apiCall('answerCallbackQuery', { callback_query_id, ...options }); }
	async sendVideo(chatId, video, options = {}) { return this.apiCall('sendVideo', { chat_id: chatId, video, ...options }); }

	async sendPhoto(chatId, photo, options = {}) {
		const formData = new FormData();
		formData.append('chat_id', String(chatId));
		if (photo instanceof Blob) {
			formData.append('photo', photo, 'thumbnail.jpg');
		} else {
			formData.append('photo', photo);
		}
		for (const [key, value] of Object.entries(options)) {
			formData.append(key, String(value));
		}
		try {
			const response = await fetch(`${this.apiUrl}sendPhoto`, { method: 'POST', body: formData });
			return await response.json();
		} catch (error) {
			console.error('Error sending photo:', error);
		}
	}
    
    // The library's method is correct, but we include it here for completeness
	async sendInlineKeyboard(chatId, text, buttons, options = {}) {
		const reply_markup = {
			inline_keyboard: buttons.map((row) =>
				row.map((button) => ({
					text: button.text,
                    // The library expects 'callbackData' but the API needs 'callback_data'
					callback_data: button.callbackData,
				}))
			),
		};
		return this.sendMessage(chatId, text, { ...options, reply_markup });
	}
}

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

	if (message.text && message.text.trim() === '/set_cover' && message.reply_to_message && message.reply_to_message.photo) {
		const photo = message.reply_to_message.photo;
		const cover_file_id = photo[photo.length - 1].file_id;
		await coversKV.put(String(userId), cover_file_id);
		await bot.sendMessage(chatId, '✅ Cover saved successfully!', { reply_to_message_id: message.message_id });
		return;
	}

	if (message.text && message.text.trim() === '/start') {
		await bot.sendMessage(chatId, 'Hello! Send me a video to get started. You can save a default cover by replying to an image with /set_cover.');
	} else if (message.video) {
		const savedCover = await coversKV.get(String(userId));

		const buttons = [
			[
				{ text: 'Extract Cover & Thumbnail', callbackData: 'extract_media' },
				{ text: 'Set New Cover', callbackData: 'set_cover' },
			],
		];
        
		if (savedCover) {
			buttons[0].push({ text: 'Set Saved Cover', callbackData: 'set_saved_cover' });
		}

		await bot.sendInlineKeyboard(chatId, 'What would you like to do with this video?', buttons, {
			reply_to_message_id: message.message_id,
		});
	} else if (message.photo) {
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
	const videoMessageId = original_video_message.message_id; // Get the ID of the video message

	if (action === 'extract_media') {
		await bot.editMessageText(chatId, message.message_id, 'Extracting media...');
		let foundMedia = false;

		// --- CORRECTED SECTION FOR COVER ---
		if (video.cover && Array.isArray(video.cover) && video.cover.length > 0) {
			const cover = video.cover[video.cover.length - 1];
			const fileSizeInKB = (cover.file_size || 0) / 1024;
			const caption = `**Cover**\n\n**Resolution:** \`${cover.width}x${cover.height}\`\n**File Size:** \`${fileSizeInKB.toFixed(2)}\` KB`;

			await bot.sendPhoto(chatId, cover.file_id, {
				caption: caption,
				parse_mode: 'Markdown',
				reply_to_message_id: videoMessageId, // Reply to the original video
			});
			foundMedia = true;
		}

		// --- CORRECTED SECTION FOR THUMBNAIL ---
		if (video.thumbnail) {
			const thumbnail = video.thumbnail;
			const fileInfo = await bot.getFile(thumbnail.file_id);
			if (fileInfo && fileInfo.file_path) {
				const thumbUrl = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;
				const thumbResponse = await fetch(thumbUrl);
				const thumbBlob = await thumbResponse.blob();
				const fileSizeInKB = (thumbnail.file_size || 0) / 1024;
				const caption = `**Thumbnail**\n\n**Resolution:** \`${thumbnail.width}x${thumbnail.height}\`\n**File Size:** \`${fileSizeInKB.toFixed(2)} KB\``;

				await bot.sendPhoto(chatId, thumbBlob, {
					caption: caption,
					parse_mode: 'Markdown',
					reply_to_message_id: videoMessageId, // Reply to the original video
				});
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