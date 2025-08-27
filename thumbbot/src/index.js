// A corrected, self-contained TelegramBot class to fix all library bugs
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
	
	async sendMessage(chatId, text, options = {}) {
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

	// --- THIS IS THE FIXED METHOD ---
	async editMessageText(chatId, messageId, text, options = {}) {
        // Fix: If a reply_markup is provided, convert its buttons to use 'callback_data'
        if (options.reply_markup && options.reply_markup.inline_keyboard) {
            options.reply_markup.inline_keyboard = options.reply_markup.inline_keyboard.map(row =>
                row.map(button => ({
                    text: button.text,
                    callback_data: button.callbackData || button.callback_data, // Handle both cases
                }))
            );
        }
		return this.apiCall('editMessageText', { chat_id: chatId, message_id: messageId, text, ...options });
	}
    
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
	
	async sendInlineKeyboard(chatId, text, buttons, options = {}) {
		const reply_markup = {
			inline_keyboard: buttons.map((row) =>
				row.map((button) => ({
					text: button.text,
					callback_data: button.callbackData,
				}))
			),
		};
		return this.sendMessage(chatId, text, { ...options, reply_markup });
	}
}

// In-memory store for the multi-step "set new cover" process
const userState = new Map();
const DEFAULT_COVER_NAME = '__default__';

// The main entry point for the ES Module Worker
export default {
	async fetch(request, env, ctx) {
		try {
			if (!env.BOT_TOKEN || !env.COVERS_KV || !env.STATS_KV) {
				return new Response('Required environment variables (BOT_TOKEN, COVERS_KV, STATS_KV) are not set', { status: 500 });
			}
			const bot = new TelegramBot(env.BOT_TOKEN);
			const url = new URL(request.url);

			if (url.pathname === '/webhook') {
				const update = await request.json();
				ctx.waitUntil(handleUpdate(update, bot, env)); // Pass the entire env object
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
async function handleUpdate(update, bot, env) {
	if (update.callback_query) {
		await handleCallback(update.callback_query, bot, env);
	} else if (update.message) {
		await handleMessage(update.message, bot, env);
	}
}

// Handles regular messages (text, video, photos)
async function handleMessage(message, bot, env) {
	const chatId = message.chat.id;
	const userId = message.from.id;

	if (message.text) {
        const text = message.text.trim();
        const command = text.split(' ')[0];
        const args = text.split(' ').slice(1);

		if (command === '/start') {
			await bot.sendMessage(chatId, 'Hello! Send me a video to get started.\n\n**Commands:**\n`/save_cover [name]` - Reply to an image to save it. If no name is given, it saves as your default.\n`/covers` - Manage your saved covers.\n`/stats` - View your usage statistics.', { parse_mode: 'Markdown' });
		} else if (command === '/save_cover' && message.reply_to_message && message.reply_to_message.photo) {
			const name = args[0] || DEFAULT_COVER_NAME;
			const photo = message.reply_to_message.photo;
			const cover_file_id = photo[photo.length - 1].file_id;
			const userCovers = (await env.COVERS_KV.get(String(userId), 'json')) || {};
			userCovers[name] = cover_file_id;
			await env.COVERS_KV.put(String(userId), JSON.stringify(userCovers));
            
            const confirmationText = name === DEFAULT_COVER_NAME ? '✅ Default cover saved successfully!' : `✅ Cover saved as "${name}" successfully!`;
			await bot.sendMessage(chatId, confirmationText, { reply_to_message_id: message.message_id });
		} else if (command === '/covers') {
            const userCovers = (await env.COVERS_KV.get(String(userId), 'json')) || {};
            const coverNames = Object.keys(userCovers);
            if (coverNames.length === 0) {
                await bot.sendMessage(chatId, "You don't have any saved covers.", { reply_to_message_id: message.message_id });
                return;
            }
            // Create a row of buttons for each cover
            const buttons = coverNames.map(name => ([
                { text: `🖼️ ${name === DEFAULT_COVER_NAME ? 'Default' : name}`, callbackData: `send_cover_${name}` },
                { text: '🗑️ Delete', callbackData: `confirm_delete_${name}` }
            ]));
            await bot.sendInlineKeyboard(chatId, 'Manage your saved covers:', buttons, { reply_to_message_id: message.message_id });
        } else if (command === '/stats') {
			const stats = (await env.STATS_KV.get(String(userId), 'json')) || { videos_processed: 0, covers_changed: 0 };
			await bot.sendMessage(chatId, `**Your Stats:**\n- Videos Processed: ${stats.videos_processed}\n- Covers Changed: ${stats.covers_changed}`, { parse_mode: 'Markdown', reply_to_message_id: message.message_id });
		}
	} else if (message.video) {
        const stats = (await env.STATS_KV.get(String(userId), 'json')) || { videos_processed: 0, covers_changed: 0 };
        stats.videos_processed++;
        await env.STATS_KV.put(String(userId), JSON.stringify(stats));

		const buttons = [
            [{ text: 'Extract Metadata', callbackData: 'extract_metadata' }],
			[{ text: 'Extract Cover & Thumbnail', callbackData: 'extract_media' }],
			[{ text: 'Set New Cover (for this video)', callbackData: 'set_cover' }],
            [{ text: 'Use Saved Cover', callbackData: 'use_saved_cover' }],
		];

		await bot.sendInlineKeyboard(chatId, 'What would you like to do with this video?', buttons, {
			reply_to_message_id: message.message_id,
		});
	} else if (message.photo) {
		if (userState.has(userId)) {
			const { video_file_id, original_caption, message_id } = userState.get(userId);
			const new_cover_file_id = message.photo[message.photo.length - 1].file_id;

			const stats = (await env.STATS_KV.get(String(userId), 'json')) || { videos_processed: 0, covers_changed: 0 };
            stats.covers_changed++;
            await env.STATS_KV.put(String(userId), JSON.stringify(stats));

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
async function handleCallback(callback_query, bot, env) {
	const action = callback_query.data;
	const message = callback_query.message;
	const chatId = message.chat.id;
	const userId = callback_query.from.id;

    // --- Logic for /covers menu (does not need a replied-to message) ---
    if (action.startsWith('send_cover_') || action.startsWith('confirm_delete_') || action.startsWith('delete_cover_') || action === 'cancel_delete') {
        if (action.startsWith('send_cover_')) {
            const coverName = action.replace('send_cover_', '');
            const userCovers = (await env.COVERS_KV.get(String(userId), 'json')) || {};
            const fileId = userCovers[coverName];
            if (fileId) {
                await bot.sendPhoto(chatId, fileId, { caption: `Your "${coverName === DEFAULT_COVER_NAME ? 'Default' : coverName}" cover.` });
            }
            await bot.answerCallbackQuery(callback_query.id);
        } else if (action.startsWith('confirm_delete_')) {
            const coverName = action.replace('confirm_delete_', '');
            const buttons = [[
                { text: `Yes, delete "${coverName === DEFAULT_COVER_NAME ? 'Default' : coverName}"`, callbackData: `delete_cover_${coverName}` },
                { text: 'Cancel', callbackData: 'cancel_delete' }
            ]];
            // This is where the error was. We are now using the fixed editMessageText method.
            await bot.editMessageText(chatId, message.message_id, `Are you sure you want to delete this cover?`, { reply_markup: { inline_keyboard: buttons } });
            await bot.answerCallbackQuery(callback_query.id);
        } else if (action.startsWith('delete_cover_')) {
            const coverName = action.replace('delete_cover_', '');
            const userCovers = (await env.COVERS_KV.get(String(userId), 'json')) || {};
            if (userCovers[coverName]) {
                delete userCovers[coverName];
                await env.COVERS_KV.put(String(userId), JSON.stringify(userCovers));
                await bot.editMessageText(chatId, message.message_id, `🗑️ Cover "${coverName === DEFAULT_COVER_NAME ? 'Default' : coverName}" has been deleted.`);
            } else {
                await bot.editMessageText(chatId, message.message_id, `Could not find that cover.`);
            }
            await bot.answerCallbackQuery(callback_query.id);
        } else if (action === 'cancel_delete') {
            await bot.editMessageText(chatId, message.message_id, 'Deletion cancelled.');
            await bot.answerCallbackQuery(callback_query.id);
        }
        return; // Stop execution here for these actions
    }
    // --- End of /covers logic ---

    // --- Logic for video actions (requires a replied-to message) ---
	const original_video_message = message.reply_to_message;
	if (!original_video_message || !original_video_message.video) {
        await bot.answerCallbackQuery(callback_query.id);
		await bot.editMessageText(chatId, message.message_id, 'Sorry, the original video could not be found. Please send a new one.');
		return;
	}

	const video = original_video_message.video;
	const original_caption = original_video_message.caption;
	const videoMessageId = original_video_message.message_id;

	if (action === 'extract_metadata') {
        await bot.answerCallbackQuery(callback_query.id);
		const fileSizeInMB = (video.file_size || 0) / (1024 * 1024);
        const durationSeconds = video.duration || 0;
        const hours = Math.floor(durationSeconds / 3600);
        const minutes = Math.floor((durationSeconds % 3600) / 60);
        const seconds = durationSeconds % 60;
        const formattedDuration = `${hours > 0 ? `${hours} h ` : ''}${minutes > 0 ? `${minutes} min ` : ''}${seconds} s`;

		const metadata = "🗒 **General**\n" +
            `**Complete name:** \`${video.file_name || 'N/A'}\`\n` +
            `**File size:** \`${fileSizeInMB.toFixed(2)} MiB\`\n` +
            `**Duration:** \`${formattedDuration}\`\n\n` +
            "🎞 **Video**\n" +
            `**Width:** \`${video.width} pixels\`\n` +
            `**Height:** \`${video.height} pixels\`\n` +
            `**MIME Type:** \`${video.mime_type || 'N/A'}\``;

		await bot.editMessageText(chatId, message.message_id, metadata, { parse_mode: 'Markdown' });
	} else if (action === 'extract_media') {
        await bot.answerCallbackQuery(callback_query.id);
		await bot.editMessageText(chatId, message.message_id, 'Extracting media...');
		let foundMedia = false;

		if (video.cover && Array.isArray(video.cover) && video.cover.length > 0) {
			const cover = video.cover[video.cover.length - 1];
			const fileSizeInKB = (cover.file_size || 0) / 1024;
			const caption = `**Cover**\n\n**Resolution:** \`${cover.width}x${cover.height}\`\n**File Size:** \`${fileSizeInKB.toFixed(2)}\` KB`;
			await bot.sendPhoto(chatId, cover.file_id, { caption, parse_mode: 'Markdown', reply_to_message_id: videoMessageId });
			foundMedia = true;
		}

		if (video.thumbnail) {
			const fileInfo = await bot.getFile(video.thumbnail.file_id);
			if (fileInfo && fileInfo.file_path) {
				const thumbUrl = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;
				const thumbResponse = await fetch(thumbUrl);
				const thumbBlob = await thumbResponse.blob();
				const fileSizeInKB = (video.thumbnail.file_size || 0) / 1024;
				const caption = `**Thumbnail**\n\n**Resolution:** \`${video.thumbnail.width}x${video.thumbnail.height}\`\n**File Size:** \`${fileSizeInKB.toFixed(2)}\` KB`;
				await bot.sendPhoto(chatId, thumbBlob, { caption, parse_mode: 'Markdown', reply_to_message_id: videoMessageId });
				foundMedia = true;
			}
		}

		if (foundMedia) {
			await bot.deleteMessage(chatId, message.message_id);
		} else {
			await bot.editMessageText(chatId, message.message_id, 'This video does not have a cover or a thumbnail.');
		}
	} else if (action === 'set_cover') {
        await bot.answerCallbackQuery(callback_query.id);
		userState.set(userId, { video_file_id: video.file_id, original_caption, message_id: message.message_id });
		await bot.editMessageText(chatId, message.message_id, 'Please send me the new image you would like to use as a cover.');
	} else if (action === 'use_saved_cover') {
        const userCovers = (await env.COVERS_KV.get(String(userId), 'json')) || {};
        const coverNames = Object.keys(userCovers);

        if (coverNames.length === 0) {
            await bot.answerCallbackQuery(callback_query.id, {
                text: "You have no covers saved!\n\nReply to an image with the command /save_cover [name] to save one.",
                show_alert: true,
            });
            return;
        }
        
        if (coverNames.length === 1) {
            const saved_cover_file_id = userCovers[coverNames[0]];
            const stats = (await env.STATS_KV.get(String(userId), 'json')) || { videos_processed: 0, covers_changed: 0 };
            stats.covers_changed++;
            await env.STATS_KV.put(String(userId), JSON.stringify(stats));
            await bot.answerCallbackQuery(callback_query.id);
		    await bot.editMessageText(chatId, message.message_id, 'Applying your saved cover...');
		    await bot.sendVideo(chatId, video.file_id, { cover: saved_cover_file_id, caption: original_caption });
		    await bot.deleteMessage(chatId, message.message_id);
        } else {
            const buttons = coverNames.map(name => ([{ text: name === DEFAULT_COVER_NAME ? 'Default' : name, callbackData: `apply_cover_${name}` }]));
            await bot.editMessageText(chatId, message.message_id, 'Please choose a cover to apply:', { reply_markup: { inline_keyboard: buttons } });
            await bot.answerCallbackQuery(callback_query.id);
        }
    } else if (action.startsWith('apply_cover_')) {
        const coverName = action.replace('apply_cover_', '');
        const userCovers = (await env.COVERS_KV.get(String(userId), 'json')) || {};
        const saved_cover_file_id = userCovers[coverName];

		if (!saved_cover_file_id) {
			await bot.answerCallbackQuery(callback_query.id, { text: "This cover seems to have been deleted.", show_alert: true });
			return;
		}

        const stats = (await env.STATS_KV.get(String(userId), 'json')) || { videos_processed: 0, covers_changed: 0 };
        stats.covers_changed++;
        await env.STATS_KV.put(String(userId), JSON.stringify(stats));

        await bot.answerCallbackQuery(callback_query.id);
		await bot.editMessageText(chatId, message.message_id, `Applying the "${coverName === DEFAULT_COVER_NAME ? 'Default' : coverName}" cover...`);
		await bot.sendVideo(chatId, video.file_id, { cover: saved_cover_file_id, caption: original_caption });
		await bot.deleteMessage(chatId, message.message_id);
    }
}