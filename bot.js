const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
require('dotenv').config();

// Configuration from environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const LTA_API_KEY = process.env.LTA_API_KEY;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Validate required environment variables
if (!BOT_TOKEN || !LTA_API_KEY) {
    console.error('❌ Missing required environment variables:');
    if (!BOT_TOKEN) console.error('   - BOT_TOKEN is required');
    if (!LTA_API_KEY) console.error('   - LTA_API_KEY is required');
    console.error('   Please check your .env file or Railway environment variables');
    process.exit(1);
}

// Debug API key (show first 8 characters only for security)
console.log('🔑 API Key (first 8 chars):', LTA_API_KEY.substring(0, 8) + '...');

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Updated API endpoints - trying different variations
const API_ENDPOINTS = {
    // Try HTTPS first (recommended)
    primary: 'https://datamall2.mytransport.sg/ltaodataservice',
    // Fallback to HTTP if HTTPS doesn't work
    fallback: 'http://datamall2.mytransport.sg/ltaodataservice'
};

const SEARCH_RADIUS = 50;
const MAX_BUS_STOPS = 3;
const REQUEST_TIMEOUT = 15000; // Increased timeout

// Test API connectivity
const testAPIConnection = async () => {
    console.log('🧪 Testing API connectivity...');
    
    for (const [name, baseUrl] of Object.entries(API_ENDPOINTS)) {
        try {
            console.log(`   Testing ${name}: ${baseUrl}`);
            
            const response = await axios.get(`${baseUrl}/BusStops`, {
                headers: {
                    'AccountKey': LTA_API_KEY,
                    'accept': 'application/json'
                },
                params: {
                    '$skip': 0,
                    '$top': 1 // Just get 1 record for testing
                },
                timeout: REQUEST_TIMEOUT
            });
            
            if (response.data && response.data.value) {
                console.log(`   ✅ ${name} endpoint working! Got ${response.data.value.length} record(s)`);
                return baseUrl; // Return working endpoint
            }
            
        } catch (error) {
            console.log(`   ❌ ${name} failed:`, error.response?.status, error.response?.statusText || error.message);
            
            // Log more details for debugging
            if (error.response) {
                console.log(`   Response headers:`, error.response.headers);
                console.log(`   Response data:`, error.response.data);
            }
        }
    }
    
    return null; // No working endpoint found
};

// Store working API endpoint
let WORKING_API_ENDPOINT = null;

// In-memory storage
const userSessions = new Map();
const busStopsCache = {
    data: [],
    lastUpdated: 0
};

// Utility Functions
const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
};

const formatArrivalTime = (arrivalTime) => {
    if (!arrivalTime) return 'No data';
    
    const now = new Date();
    const arrival = new Date(arrivalTime);
    const diffMinutes = Math.round((arrival - now) / (1000 * 60));
    
    if (diffMinutes <= 0) return 'Arriving';
    if (diffMinutes === 1) return '1 min';
    return `${diffMinutes} mins`;
};

const formatLoad = (load) => {
    const loadMap = {
        'SEA': '🟢',
        'SDA': '🟡',
        'LSD': '🔴',
    };
    return loadMap[load] || '⚪';
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Enhanced API request function with debugging
const makeAPIRequest = async (endpoint, params = {}, retries = 2) => {
    if (!WORKING_API_ENDPOINT) {
        throw new Error('No working API endpoint available');
    }
    
    const url = `${WORKING_API_ENDPOINT}/${endpoint}`;
    console.log(`🌐 Making API request to: ${url}`);
    console.log(`📋 Parameters:`, params);
    
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
            const response = await axios.get(url, {
                headers: {
                    'AccountKey': LTA_API_KEY,
                    'accept': 'application/json',
                    'User-Agent': 'Singapore-Bus-Bot/2.0'
                },
                params,
                timeout: REQUEST_TIMEOUT
            });
            
            console.log(`✅ API request successful (attempt ${attempt})`);
            return response.data;
            
        } catch (error) {
            console.error(`❌ API request attempt ${attempt} failed:`, {
                status: error.response?.status,
                statusText: error.response?.statusText,
                message: error.message,
                url: url
            });
            
            // Log response details for debugging
            if (error.response) {
                console.log(`Response headers:`, error.response.headers);
                console.log(`Response data:`, error.response.data);
            }
            
            if (attempt <= retries) {
                const delay = Math.pow(2, attempt) * 1000;
                console.log(`⏳ Retrying in ${delay}ms...`);
                await sleep(delay);
            } else {
                throw error;
            }
        }
    }
};

// Get all bus stops with enhanced debugging
const getAllBusStops = async () => {
    console.log('🚌 Fetching bus stops data...');
    
    try {
        let allBusStops = [];
        let skip = 0;
        const limit = 500;
        let totalRequests = 0;

        while (true) {
            totalRequests++;
            console.log(`📡 Request ${totalRequests}: fetching ${limit} records (skip: ${skip})`);
            
            const data = await makeAPIRequest('BusStops', { '$skip': skip });
            
            const busStops = data.value;
            if (!busStops || busStops.length === 0) {
                console.log('✅ No more bus stops to fetch');
                break;
            }

            allBusStops = allBusStops.concat(busStops);
            console.log(`📊 Progress: ${allBusStops.length} bus stops loaded`);
            
            skip += limit;

            // Add delay to avoid rate limiting
            if (busStops.length === limit) {
                await sleep(200);
            }
            
            // Safety check to avoid infinite loops
            if (totalRequests > 20) {
                console.log('⚠️ Safety limit reached, stopping fetch');
                break;
            }
        }

        busStopsCache.data = allBusStops;
        busStopsCache.lastUpdated = Date.now();
        
        console.log(`✅ Successfully loaded ${allBusStops.length} bus stops`);
        return allBusStops;
        
    } catch (error) {
        console.error('❌ Error fetching bus stops:', error.message);
        console.error('Stack trace:', error.stack);
        return busStopsCache.data; // Return cached data if available
    }
};

const findNearbyBusStops = (userLat, userLng, busStops, radiusMeters = SEARCH_RADIUS) => {
    console.log(`🔍 Searching for bus stops within ${radiusMeters}m of (${userLat}, ${userLng})`);
    
    const nearby = [];
    
    for (const stop of busStops) {
        const distance = calculateDistance(userLat, userLng, stop.Latitude, stop.Longitude);
        if (distance <= radiusMeters) {
            nearby.push({
                ...stop,
                distance: Math.round(distance)
            });
        }
    }

    const sorted = nearby.sort((a, b) => a.distance - b.distance).slice(0, MAX_BUS_STOPS);
    console.log(`📍 Found ${sorted.length} nearby bus stops`);
    
    return sorted;
};

const getBusArrivals = async (busStopCode) => {
    console.log(`🚌 Getting arrivals for bus stop: ${busStopCode}`);
    
    try {
        const data = await makeAPIRequest('BusArrivalv2', { 'BusStopCode': busStopCode });
        console.log(`✅ Got arrival data for ${busStopCode}: ${data.Services?.length || 0} services`);
        return data;
    } catch (error) {
        console.error(`❌ Error fetching arrivals for ${busStopCode}:`, error.message);
        return null;
    }
};

// Message formatting (same as before)
const formatBusArrivalsMessage = (busStop, arrivalsData) => {
    if (!arrivalsData || !arrivalsData.Services || arrivalsData.Services.length === 0) {
        return `🚌 *${busStop.Description}*\n` +
               `🏷️ Stop: ${busStop.BusStopCode}\n` +
               `📍 Distance: ${busStop.distance}m\n\n` +
               `❌ No buses currently serving this stop.`;
    }

    let message = `🚌 *${busStop.Description}*\n` +
                  `🏷️ Stop: ${busStop.BusStopCode}\n` +
                  `📍 Distance: ${busStop.distance}m\n\n`;

    const sortedServices = arrivalsData.Services.sort((a, b) => {
        const numA = parseInt(a.ServiceNo) || 999;
        const numB = parseInt(b.ServiceNo) || 999;
        return numA - numB;
    });

    sortedServices.forEach((service, index) => {
        const busNumber = service.ServiceNo;
        const nextBus = formatArrivalTime(service.NextBus?.EstimatedArrival);
        const nextBus2 = formatArrivalTime(service.NextBus2?.EstimatedArrival);
        const nextBus3 = formatArrivalTime(service.NextBus3?.EstimatedArrival);
        
        const load1 = formatLoad(service.NextBus?.Load);
        const load2 = formatLoad(service.NextBus2?.Load);
        const load3 = formatLoad(service.NextBus3?.Load);

        message += `🚍 *Bus ${busNumber}*\n`;
        message += `   ${load1} ${nextBus}`;
        if (nextBus2 !== 'No data') message += ` • ${load2} ${nextBus2}`;
        if (nextBus3 !== 'No data') message += ` • ${load3} ${nextBus3}`;
        message += '\n';
        
        if (index < sortedServices.length - 1) message += '\n';
    });

    message += '\n\n🟢 Seats Available • 🟡 Standing Available • 🔴 Limited Standing';
    return message;
};

// Keyboard creation (same as before)
const createBusStopKeyboard = (busStopCode) => ({
    inline_keyboard: [
        [{ text: '🔄 Update Arrivals', callback_data: `update_${busStopCode}` }],
        [{ text: '📍 Share Location Again', callback_data: 'share_location' }]
    ]
});

const createLocationKeyboard = () => ({
    keyboard: [[{ text: '📍 Share Location', request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true
});

// Bot commands with debug info
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'there';
    
    console.log(`👤 User ${userName} (${chatId}) started the bot`);
    
    const welcomeMessage = 
        `🚌 *Welcome to Singapore Bus Bot, ${userName}!*\n\n` +
        `I help you find nearby bus stops and get real-time bus arrival information.\n\n` +
        `*How to use:*\n` +
        `1️⃣ Share your location using the button below\n` +
        `2️⃣ I'll find bus stops within ${SEARCH_RADIUS} meters\n` +
        `3️⃣ View real-time bus arrivals with load status\n` +
        `4️⃣ Use the update button to refresh timing\n\n` +
        `*Commands:*\n` +
        `• /help - Show help information\n` +
        `• /debug - Show system status\n` +
        `• /test - Test API connection\n\n` +
        `Ready to find your bus? Share your location! 📍`;

    await bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: createLocationKeyboard()
    });
});

// Debug command
bot.onText(/\/debug/, async (msg) => {
    const chatId = msg.chat.id;
    
    const debugInfo = 
        `🔧 *Debug Information*\n\n` +
        `*System Status:*\n` +
        `• Environment: ${NODE_ENV}\n` +
        `• API Endpoint: ${WORKING_API_ENDPOINT || 'Not set'}\n` +
        `• Bot Token: ${BOT_TOKEN ? 'Set ✅' : 'Missing ❌'}\n` +
        `• LTA API Key: ${LTA_API_KEY ? 'Set ✅' : 'Missing ❌'}\n\n` +
        `*Cache Status:*\n` +
        `• Bus Stops Cached: ${busStopsCache.data.length}\n` +
        `• Last Updated: ${busStopsCache.lastUpdated ? new Date(busStopsCache.lastUpdated).toLocaleTimeString() : 'Never'}\n\n` +
        `*Active Sessions:* ${userSessions.size}`;

    await bot.sendMessage(chatId, debugInfo, { parse_mode: 'Markdown' });
});

// Test command
bot.onText(/\/test/, async (msg) => {
    const chatId = msg.chat.id;
    
    await bot.sendMessage(chatId, '🧪 Testing API connection...');
    
    const workingEndpoint = await testAPIConnection();
    
    if (workingEndpoint) {
        await bot.sendMessage(chatId, `✅ API connection successful!\nUsing: ${workingEndpoint}`);
    } else {
        await bot.sendMessage(chatId, '❌ API connection failed. Check logs for details.');
    }
});

// Location handler (same as before but with more logging)
bot.on('location', async (msg) => {
    const chatId = msg.chat.id;
    const { latitude, longitude } = msg.location;

    console.log(`📍 Location received from user ${chatId}: (${latitude}, ${longitude})`);

    userSessions.set(chatId, { 
        latitude, 
        longitude, 
        timestamp: Date.now() 
    });

    const searchingMsg = await bot.sendMessage(chatId, '🔍 Searching for nearby bus stops...');

    try {
        const busStopsData = busStopsCache.data.length > 0 ? busStopsCache.data : await getAllBusStops();
        
        if (busStopsData.length === 0) {
            await bot.editMessageText(
                '❌ Unable to load bus stops data. Please try /test to check API connection.', {
                chat_id: chatId,
                message_id: searchingMsg.message_id
            });
            return;
        }

        const nearbyStops = findNearbyBusStops(latitude, longitude, busStopsData);

        if (nearbyStops.length === 0) {
            await bot.editMessageText(
                `❌ No bus stops found within ${SEARCH_RADIUS} meters.\n\n` +
                `Try moving closer to a bus stop or use /debug for system status.`, {
                chat_id: chatId,
                message_id: searchingMsg.message_id
            });
            return;
        }

        await bot.deleteMessage(chatId, searchingMsg.message_id);
        await bot.sendMessage(chatId, 
            `📍 Found ${nearbyStops.length} bus stop${nearbyStops.length > 1 ? 's' : ''} nearby:\n` +
            `Loading arrival information...`
        );

        for (const [index, busStop] of nearbyStops.entries()) {
            const loadingMsg = await bot.sendMessage(chatId, 
                `🔄 Loading arrivals for ${busStop.Description}...`
            );
            
            try {
                const arrivalsData = await getBusArrivals(busStop.BusStopCode);
                const message = formatBusArrivalsMessage(busStop, arrivalsData);
                
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: createBusStopKeyboard(busStop.BusStopCode)
                });

                if (index < nearbyStops.length - 1) {
                    await sleep(500);
                }
            } catch (error) {
                console.error(`Error loading arrivals for ${busStop.BusStopCode}:`, error);
                await bot.editMessageText(
                    `❌ Unable to load arrivals for ${busStop.Description}. Please try updating.`, {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                    reply_markup: createBusStopKeyboard(busStop.BusStopCode)
                });
            }
        }

    } catch (error) {
        console.error('Error processing location:', error);
        await bot.editMessageText(
            '❌ An error occurred while searching. Use /debug for more info.', {
            chat_id: chatId,
            message_id: searchingMsg.message_id
        });
    }
});

// Callback query handler (same as before)
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    console.log(`🔘 Callback query from user ${chatId}: ${data}`);

    try {
        if (data.startsWith('update_')) {
            const busStopCode = data.replace('update_', '');
            
            await bot.editMessageText('🔄 Updating bus arrivals...', {
                chat_id: chatId,
                message_id: messageId
            });

            const userSession = userSessions.get(chatId);
            if (!userSession) {
                await bot.editMessageText(
                    '❌ Session expired. Please share your location again.', {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: { inline_keyboard: [[
                        { text: '📍 Share Location', callback_data: 'share_location' }
                    ]]}
                });
                return;
            }

            const busStopsData = busStopsCache.data;
            const nearbyStops = findNearbyBusStops(
                userSession.latitude, 
                userSession.longitude, 
                busStopsData
            );
            
            const busStop = nearbyStops.find(stop => stop.BusStopCode === busStopCode);
            if (!busStop) {
                await bot.editMessageText(
                    '❌ Bus stop not found. Please search again.', {
                    chat_id: chatId,
                    message_id: messageId
                });
                return;
            }

            const arrivalsData = await getBusArrivals(busStopCode);
            const message = formatBusArrivalsMessage(busStop, arrivalsData);
            
            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: createBusStopKeyboard(busStopCode)
            });
            
        } else if (data === 'share_location') {
            await bot.sendMessage(chatId, 
                '📍 Please share your location to find nearby bus stops:', {
                reply_markup: createLocationKeyboard()
            });
        }

        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '✅ Updated!'
        });

    } catch (error) {
        console.error('Error handling callback:', error);
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '❌ Update failed. Please try again.',
            show_alert: true
        });
    }
});

// Error handlers
bot.on('error', (error) => {
    console.error('❌ Bot error:', error.message);
});

bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error.message);
});

// Initialize and start
const initializeBot = async () => {
    try {
        console.log('🚀 Starting Singapore Bus Bot (Debug Version)...');
        console.log(`📝 Environment: ${NODE_ENV}`);
        
        // Test API connection first
        WORKING_API_ENDPOINT = await testAPIConnection();
        
        if (!WORKING_API_ENDPOINT) {
            console.error('❌ No working API endpoint found!');
            console.error('🔧 Troubleshooting steps:');
            console.error('   1. Check your LTA_API_KEY in .env file');
            console.error('   2. Verify your API key at https://datamall.lta.gov.sg');
            console.error('   3. Check if your API key is activated');
            console.error('   4. Try running /test command in the bot');
            console.error('');
            console.error('⚠️  Bot will start but bus data will not work until API is fixed');
        } else {
            // Pre-load bus stops data only if API is working
            await getAllBusStops();
        }
        
        console.log('✅ Singapore Bus Bot is running!');
        console.log('💡 Available commands: /start, /debug, /test');
        
    } catch (error) {
        console.error('❌ Failed to initialize bot:', error.message);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }
};

// Start the bot
initializeBot();