// src/index.js

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
			link_preview_options: options.link_preview_options,
		});
	}

	async editMessageText(chatId, messageId, text, options = {}) {
        if (options.reply_markup && options.reply_markup.inline_keyboard) {
            options.reply_markup.inline_keyboard = options.reply_markup.inline_keyboard.map(row =>
                row.map(button => ({
                    text: button.text,
                    callback_data: button.callbackData || button.callback_data,
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

// In-memory store for multi-step processes
const userState = new Map();
const DEFAULT_COVER_NAME = '__default__';

// The main entry point for the ES Module Worker
export default {
	async fetch(request, env, ctx) {
		try {
			// --- MODIFICATION: Added USER_STORE to the check ---
			if (!env.BOT_TOKEN || !env.COVERS_KV || !env.STATS_KV || !env.USER_STORE) {
				return new Response('Required environment variables (BOT_TOKEN, COVERS_KV, STATS_KV, USER_STORE) are not set', { status: 500 });
			}
			const bot = new TelegramBot(env.BOT_TOKEN);
			const url = new URL(request.url);

			if (url.pathname === '/webhook') {
				const update = await request.json();
				ctx.waitUntil(handleUpdate(update, bot, env));
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

// Handles regular messages
async function handleMessage(message, bot, env) {
	const chatId = message.chat.id;
	const userId = message.from.id;

	if (message.text) {
        const text = message.text.trim();
        const command = text.split(' ')[0];
        const args = text.split(' ').slice(1);
        
        if (userState.has(userId) && userState.get(userId).action === 'awaiting_cover_name') {
            const { cover_file_id, message_id } = userState.get(userId);
            const name = text;
			const userCovers = (await env.COVERS_KV.get(String(userId), 'json')) || {};
			userCovers[name] = cover_file_id;
			await env.COVERS_KV.put(String(userId), JSON.stringify(userCovers));
            
            await bot.editMessageText(chatId, message_id, `✅ Cover saved as "${name}" successfully!`);
            userState.delete(userId);
            return;
        }

		if (command === '/start') {
			// --- MODIFICATION: Store user ID ---
			await env.USER_STORE.put(String(userId), "1");

            const buttons = [
                [{ text: 'Update Channel', url: 'https://t.me/Blaze_Updatez' }]
            ];
			await bot.sendMessage(chatId,
				  '<blockquote expandable><b>Hello! I am 🔥 Blaze thumbnail/cover changer bot. Send me a video to get started.</b>\n\n' +
				    'Commands:\n' +
				    '/save_cover [name] — Reply to an image to save it. If no name is given, it saves as your default.\n' +
				    '/covers — Manage your saved covers.\n' +
				    '/stats — View your usage statistics.' +
				  '</blockquote>',
				  {
				    parse_mode: 'HTML',
				    link_preview_options: {
				      is_disabled: false,
				      url: 'https://iili.io/K2LIM79.md.jpg',
				      prefer_large_media: true,
				      show_above_text: true
				    },
				    reply_markup: {
				      inline_keyboard: buttons
				    }
				  }
				);
		} else if (command === '/save_cover') {
	    	if (message.reply_to_message && message.reply_to_message.photo) {
	    	    const name = args[0] || DEFAULT_COVER_NAME;
	    	    const photo = message.reply_to_message.photo;
	    	    const cover_file_id = photo[photo.length - 1].file_id;
			
	    	    const userCovers = (await env.COVERS_KV.get(String(userId), 'json')) || {};
	    	    userCovers[name] = cover_file_id;
	    	    await env.COVERS_KV.put(String(userId), JSON.stringify(userCovers));
			
	    	    const confirmationText = name === DEFAULT_COVER_NAME
	    	        ? '✅ Default cover saved successfully!'
	    	        : `✅ Cover saved as "${name}" successfully!`;
			
	    	    await bot.sendMessage(chatId, confirmationText, {
	    	        reply_to_message_id: message.message_id
	    	    });
	    	} else {
	    	    await bot.sendMessage(chatId,
	    	        '❗ To use <b>/save_cover</b>, reply to an image with the command.\n\n' +
	    	        'Example: <code>/save_cover mycover</code>',
	    	        { parse_mode: 'HTML' }
	    	    );
	    	}
	    } else if (command === '/covers') {
            const userCovers = (await env.COVERS_KV.get(String(userId), 'json')) || {};
            const coverNames = Object.keys(userCovers);
            if (coverNames.length === 0) {
                await bot.sendMessage(chatId, "You don't have any saved covers.", { reply_to_message_id: message.message_id });
                return;
            }
            const buttons = coverNames.map(name => ([
                { text: `🖼️ ${name === DEFAULT_COVER_NAME ? 'Default' : name}`, callbackData: `send_cover_${name}` },
                { text: '🗑️ Delete', callbackData: `confirm_delete_${name}` }
            ]));
            await bot.sendInlineKeyboard(chatId, 'Manage your saved covers:', buttons, { reply_to_message_id: message.message_id });
        } else if (command === '/stats') {
			const stats = (await env.STATS_KV.get(String(userId), 'json')) || { videos_processed: 0, covers_changed: 0 };
			await bot.sendMessage(chatId, `**Your Stats:**\n- Videos Processed: ${stats.videos_processed}\n- Covers Changed: ${stats.covers_changed}`, { parse_mode: 'Markdown', reply_to_message_id: message.message_id });
		// --- MODIFICATION: Added /usersx command ---
		} else if (command === '/usersx') {
			const keys = await env.USER_STORE.list();
			const userCount = keys.keys.length;
			await bot.sendMessage(chatId, `📊 <b>Total Unique Users:</b> ${userCount}`, { parse_mode: 'HTML' });
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
		if (userState.has(userId) && userState.get(userId).action === 'awaiting_new_cover') {
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
		} else {
            const buttons = [
                [{ text: '🔗 Paste', callbackData: 'paste_image' }],
                [{ text: '💾 Save Cover', callbackData: 'save_cover' }]
            ];
            await bot.sendInlineKeyboard(chatId, 'What would you like to do with this image?', buttons, {
                reply_to_message_id: message.message_id,
            });
        }
	}
}

// Handles clicks from inline buttons
async function handleCallback(callback_query, bot, env) {
	const action = callback_query.data;
	const message = callback_query.message;
	const chatId = message.chat.id;
	const userId = callback_query.from.id;

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
        return;
    }

    if (action === 'paste_image' || action === 'save_cover' || action === 'save_default' || action === 'save_with_name') {
        const original_photo_message = message.reply_to_message;
        if (!original_photo_message || !original_photo_message.photo) {
            await bot.answerCallbackQuery(callback_query.id);
            await bot.editMessageText(chatId, message.message_id, 'Sorry, the original photo could not be found.');
            return;
        }
        const photo = original_photo_message.photo;
        const file_id = photo[photo.length - 1].file_id;

        if (action === 'paste_image') {
            await bot.editMessageText(chatId, message.message_id, '🔗 Pasting image, please wait...');
            const fileInfo = await bot.getFile(file_id);
            if (fileInfo && fileInfo.file_path) {
                const imageUrl = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;
                const imageResponse = await fetch(imageUrl);
                const blob = await imageResponse.blob();
                
                // --- MODIFICATION: Added fallback pasting logic ---
                try {
                    // Try the first service
                    const formData = new FormData();
                    formData.append('file', blob, 'image.jpg');
                    const pasteResponse = await fetch("https://envs.sh/", { method: 'POST', body: formData });
                    if (!pasteResponse.ok) throw new Error('First paste service failed');
                    const pasteUrl = (await pasteResponse.text()).trim();
                    await bot.editMessageText(chatId, message.message_id, `Here is your link:\n${pasteUrl}`);
                } catch (error) {
                    // If first service fails, try the second one
                    console.error("Primary paste service failed:", error);
                    await bot.editMessageText(chatId, message.message_id, 'Primary paste service failed, trying fallback...');
                    try {
                        const IMGBB_UPLOAD_URL = "https://api-integretion-unblocked.vercel.app/imgbb";
                        const formData = new FormData();
                        const fileName = `${crypto.randomUUID()}.jpg`;
                        formData.append("file", new Blob([await blob.arrayBuffer()], { type: "image/jpeg" }), fileName);
                        const response = await fetch(IMGBB_UPLOAD_URL, { method: "POST", body: formData });
                        const data = await response.json();
                        if (data.url) {
                            await bot.editMessageText(chatId, message.message_id, `Here is your link:\n${data.url}`);
                        } else {
                            throw new Error('Fallback service returned no URL.');
                        }
                    } catch (fallbackError) {
                        console.error("Fallback paste service failed:", fallbackError);
                        await bot.editMessageText(chatId, message.message_id, 'Failed to paste the image using both primary and fallback services.');
                    }
                }
            }
            await bot.answerCallbackQuery(callback_query.id);
        } else if (action === 'save_cover') {
            const buttons = [
                [{ text: 'Save as Default', callbackData: 'save_default' }],
                [{ text: 'Save with Name', callbackData: 'save_with_name' }]
            ];
            await bot.editMessageText(chatId, message.message_id, 'How would you like to save this cover?', { reply_markup: { inline_keyboard: buttons } });
            await bot.answerCallbackQuery(callback_query.id);
        } else if (action === 'save_default') {
            const userCovers = (await env.COVERS_KV.get(String(userId), 'json')) || {};
            userCovers[DEFAULT_COVER_NAME] = file_id;
            await env.COVERS_KV.put(String(userId), JSON.stringify(userCovers));
            await bot.editMessageText(chatId, message.message_id, '✅ Default cover saved successfully!');
            await bot.answerCallbackQuery(callback_query.id);
        } else if (action === 'save_with_name') {
            userState.set(userId, { action: 'awaiting_cover_name', cover_file_id: file_id, message_id: message.message_id });
            await bot.editMessageText(chatId, message.message_id, 'Please reply with a name for this cover.');
            await bot.answerCallbackQuery(callback_query.id);
        }
        return;
    }

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
		userState.set(userId, { action: 'awaiting_new_cover', video_file_id: video.file_id, original_caption, message_id: message.message_id });
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