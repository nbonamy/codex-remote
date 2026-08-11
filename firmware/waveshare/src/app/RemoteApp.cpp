#include "RemoteApp.h"

#include "../Config.h"
#include "../diag/Log.h"
#include "../hal/Board.h"
#include <WiFi.h>

namespace {
constexpr uint16_t kBlack = 0x0000;
constexpr uint16_t kPanel = 0x0842;
constexpr uint16_t kPanelSelected = 0x10A5;
constexpr uint16_t kPanelGlow = 0x0869;
constexpr uint16_t kLine = 0x2186;
constexpr uint16_t kWhite = 0xFFFF;
constexpr uint16_t kMuted = 0x8C71;
constexpr uint16_t kMint = 0x3FF4;
constexpr uint16_t kCyan = 0x07FF;
constexpr uint16_t kBlue = 0x249F;
constexpr uint16_t kViolet = 0xA81F;
constexpr uint16_t kMagenta = 0xF81F;
constexpr uint16_t kCoral = 0xFB6D;
constexpr uint16_t kYellow = 0xFE88;
constexpr uint16_t kGreen = 0x07E8;
constexpr int kThreadsPerPage = 4;
constexpr int kThreadScrollStep = kThreadsPerPage;
constexpr int kAgentsPerPage = 4;
constexpr int kMessageCharactersPerLine = 18;
constexpr int kMessageLinesPerPage = 6;
constexpr int kMessageLineHeight = 30;
constexpr int kMessagePositionY = 108;
constexpr int kMessageCardY = 136;
constexpr int kMessageCardHeight = 255;
constexpr int kMessageHeaderCenterY = 165;
constexpr int kMessageHeaderBaselineY = 172;
constexpr int kMessageTextBaselineY = 213;
constexpr int kSwipeThresholdPx = 48;
constexpr int kNewThreadCardX = 16;
constexpr int kNewThreadCardY = 368;
constexpr int kNewThreadCardWidth = 336;
constexpr int kNewThreadCardHeight = 70;
constexpr int kThreadCardX = 16;
constexpr int kThreadCardY = 92;
constexpr int kThreadCardWidth = 336;
constexpr int kThreadCardHeight = 60;
constexpr int kThreadCardPitch = 66;

void drawCenteredText(Arduino_GFX &display, const String &text, int y,
                      uint8_t size, uint16_t color) {
  display.setTextSize(size);
  display.setTextColor(color);
  const int width = text.length() * 6 * size;
  display.setCursor(max(0, (SCREEN_WIDTH_PX - width) / 2), y);
  display.print(text);
}

String fitTextToWidth(Arduino_GFX &display, const String &text, int maxWidth) {
  String fitted = text;
  int16_t x1 = 0;
  int16_t y1 = 0;
  uint16_t width = 0;
  uint16_t height = 0;
  while (!fitted.isEmpty()) {
    display.getTextBounds(fitted, 0, 0, &x1, &y1, &width, &height);
    if (width <= maxWidth) {
      return fitted;
    }
    int lastCodepoint = fitted.length() - 1;
    while (lastCodepoint > 0 &&
           (static_cast<uint8_t>(fitted[lastCodepoint]) & 0xC0) == 0x80) {
      lastCodepoint--;
    }
    fitted.remove(lastCodepoint);
  }
  return fitted;
}

void drawChevron(Arduino_GFX &display, int x, int y, uint16_t color) {
  display.drawLine(x - 5, y - 8, x + 3, y, color);
  display.drawLine(x + 3, y, x - 5, y + 8, color);
  display.drawLine(x - 2, y - 8, x + 6, y, color);
  display.drawLine(x + 6, y, x - 2, y + 8, color);
}

void drawWifiIcon(Arduino_GFX &display, int x, int y, uint16_t color) {
  display.drawLine(x - 13, y - 1, x - 7, y - 7, color);
  display.drawLine(x - 7, y - 7, x, y - 9, color);
  display.drawLine(x, y - 9, x + 7, y - 7, color);
  display.drawLine(x + 7, y - 7, x + 13, y - 1, color);
  display.drawLine(x - 8, y + 4, x - 3, y, color);
  display.drawLine(x - 3, y, x, y - 1, color);
  display.drawLine(x, y - 1, x + 3, y, color);
  display.drawLine(x + 3, y, x + 8, y + 4, color);
  display.fillCircle(x, y + 8, 2, color);
}

void drawBatteryIcon(Arduino_GFX &display, int x, int y) {
  const int level = Board::batteryLevel();
  const bool powered = Board::usbConnected();
  const uint16_t color = powered || level > 20 ? kGreen : kCoral;
  display.drawRoundRect(x, y, 27, 13, 2, kWhite);
  display.fillRect(x + 28, y + 4, 3, 5, kWhite);
  const int fill = level >= 0 ? constrain(level * 23 / 100, 2, 23) : 21;
  display.fillRoundRect(x + 2, y + 2, fill, 9, 1, color);
  if (powered) {
    display.fillTriangle(x + 13, y + 1, x + 9, y + 7, x + 13, y + 7,
                         kWhite);
    display.fillTriangle(x + 13, y + 6, x + 17, y + 6, x + 12, y + 12,
                         kWhite);
  }
}

void drawSpark(Arduino_GFX &display, int x, int y, int radius,
               uint16_t color) {
  const int waist = max(3, radius / 5);
  display.fillTriangle(x, y - radius, x - waist, y, x + waist, y, color);
  display.fillTriangle(x, y + radius, x - waist, y, x + waist, y, color);
  display.fillTriangle(x - radius, y, x, y - waist, x, y + waist, color);
  display.fillTriangle(x + radius, y, x, y - waist, x, y + waist, color);
}

void drawOrb(Arduino_GFX &display, int x, int y, int radius, bool active) {
  const int pulse = active ? static_cast<int>((millis() / 160) % 5) : 1;
  display.fillCircle(x, y, radius + 10 + pulse, 0x082A);
  display.fillCircle(x, y, radius + 4, 0x1054);
  display.fillCircle(x, y, radius, kBlue);
  display.fillCircle(x - radius / 7, y + radius / 9, radius * 4 / 5,
                     kViolet);
  display.fillCircle(x - radius / 4, y - radius / 5, radius * 3 / 5,
                     kCyan);
  display.fillCircle(x + radius / 5, y + radius / 5, radius / 2, kMagenta);
  display.fillArc(x, y, radius + 16, radius + 14, 205, 340, kCyan);
  display.fillArc(x, y, radius + 16, radius + 14, 20, 145, kViolet);
  display.fillCircle(x - radius - 13, y + 8, 4, kMint);
  display.fillCircle(x + radius + 10, y - 16, 3, kViolet);
  drawSpark(display, x, y, max(13, radius / 3), kWhite);
}

void drawMicrophone(Arduino_GFX &display, int x, int y, uint16_t color) {
  display.drawRoundRect(x - 8, y - 19, 16, 30, 8, color);
  display.drawRoundRect(x - 7, y - 18, 14, 28, 7, color);
  display.drawArc(x, y + 4, 17, 14, 0, 180, color);
  display.drawArc(x, y + 4, 16, 13, 0, 180, color);
  display.drawFastVLine(x, y + 17, 10, color);
  display.drawFastHLine(x - 10, y + 27, 21, color);
}

void drawWaveform(Arduino_GFX &display, int centerY, bool active) {
  static const uint8_t heights[] = {8,  15, 10, 24, 15, 34, 18, 44, 21,
                                    52, 19, 39, 16, 29, 12, 20, 9};
  const int phase = active ? static_cast<int>((millis() / 110) % 7) : 0;
  const int startX = 47;
  for (int i = 0; i < 17; i++) {
    int height = heights[(i + phase) % 17];
    const uint16_t color = i < 9 ? kCyan : (i < 13 ? kViolet : kMagenta);
    display.fillRoundRect(startX + i * 17, centerY - height / 2, 6, height, 3,
                          color);
  }
}

void redrawWaveform(Arduino_GFX &display, int centerY) {
  const int startX = 47;
  for (int i = 0; i < 17; i++) {
    display.fillRect(startX + i * 17, centerY - 27, 6, 54, kBlack);
  }
  drawWaveform(display, centerY, true);
}

void drawHostIcon(Arduino_GFX &display, int x, int y, uint16_t color) {
  display.drawRoundRect(x - 13, y - 10, 26, 18, 3, color);
  display.drawFastVLine(x, y + 8, 6, color);
  display.drawFastHLine(x - 8, y + 14, 17, color);
}
} // namespace

bool RemoteApp::begin() {
  Serial.begin(115200);
  delay(150);
  if (!Board::init()) {
    return false;
  }
  Arduino_GFX &display = Board::display();
  if (!display.begin()) {
    Log::client("App", "display init failed");
    return false;
  }
  display.setRotation(0);
  Board::setDisplayBrightness(DEFAULT_BRIGHTNESS);
  display.fillScreen(kBlack);
  display.setTextWrap(false);
  display.setUTF8Print(true);

  if (!_audio.init()) {
    Log::client("App", "audio init failed");
    return false;
  }
  _client.begin(this);
  _dirty = true;
  return true;
}

void RemoteApp::update() {
  Board::update();
  _client.update();
  handleButtons();
  handleTouch();

  if (_recording && _audio.captureChunk()) {
    _client.sendAudio(reinterpret_cast<const uint8_t *>(_audio.captureData()),
                      _audio.captureBytes());
  }
  if (_playbackActive) {
    _audio.advancePlayback();
    if (_audio.playbackIdle()) {
      _playbackActive = false;
      _dirty = true;
    }
  }
  if (_dirty) {
    draw();
  } else if ((_recording || _awaitingResponse) &&
             millis() - _lastDrawMs > 180) {
    drawAnimationFrame();
  }
  handleSerialDebug();
  delay(2);
}

void RemoteApp::onRemoteStateChanged() {
  if (_client.status() == "ready") {
    _ignoreRemoteAudio = false;
  }
  const int lastThreadOffset = max(0, _client.threadCount() - kThreadsPerPage);
  _threadOffset = min(_threadOffset, lastThreadOffset);
  const int lastAgentPage =
      max(0, (_client.agentCount() + kAgentsPerPage - 1) /
                     kAgentsPerPage -
                 1);
  _agentPage = min(_agentPage, lastAgentPage);
  _agentFocusIndex = _client.agentCount() == 0
                          ? 0
                          : constrain(_agentFocusIndex, 0,
                                      _client.agentCount() - 1);
  if (_client.pairingPending()) {
    _view = View::Agents;
  }
  if (_view == View::Agents && _client.connected() &&
      !_client.selectingAgent()) {
    _view = View::Threads;
  }
  updateReaderSelection();
  _dirty = true;
}

void RemoteApp::onRemoteAudio(const uint8_t *data, size_t length) {
  if (_recording || _ignoreRemoteAudio) {
    return;
  }
  if (!_playbackActive) {
    _audio.resetPlayback();
    _audio.markPlaybackStarted();
    _playbackActive = true;
    _dirty = true;
  }
  if (!_audio.queuePlayback(data, length)) {
    Log::client("App", "speaker buffer overflow");
  }
}

void RemoteApp::handleButtons() {
  const bool boot = Board::bootButtonIsPressed();
  const bool power = Board::powerButtonIsPressed();
  const bool bootPressed = boot && !_bootPrevious;
  const bool powerPressed = power && !_powerPrevious;

  if (_recording) {
    if (bootPressed) {
      cancelRecording();
    } else if (powerPressed) {
      stopRecording();
    }
  } else if (_view == View::Threads) {
    if (bootPressed) {
      showAgents();
    }
    if (powerPressed) {
      if (_client.connected()) {
        createThread();
      } else {
        showAgents();
      }
    }
  } else if (_view == View::Conversation) {
    if (bootPressed) {
      backToThreads();
    } else if (powerPressed && !_awaitingResponse) {
      startRecording();
    }
  } else {
    if (bootPressed) {
      backFromAgents();
    } else if (powerPressed) {
      confirmAgent();
    }
  }

  _bootPrevious = boot;
  _powerPrevious = power;
}

void RemoteApp::handleTouch() {
  Board::TouchPoint point;
  const bool pressed = Board::readTouch(point);
  if (pressed) {
    if (!_touchActive) {
      _touchActive = true;
      _touchStartX = point.x;
      _touchStartY = point.y;
    }
    _touchLastX = point.x;
    _touchLastY = point.y;
    return;
  }
  if (!_touchActive) {
    return;
  }

  _touchActive = false;
  const int dx = _touchLastX - _touchStartX;
  const int dy = _touchLastY - _touchStartY;
  if (abs(dy) >= kSwipeThresholdPx && abs(dy) > abs(dx) * 6 / 5) {
    if (dy > 0) {
      pageBack();
    } else {
      pageForward();
    }
    return;
  }
  if (abs(dx) < 18 && abs(dy) < 18) {
    handleTap(_touchLastX, _touchLastY);
  }
}

void RemoteApp::handleTap(int x, int y) {
  if (_view == View::Threads) {
    if (!_client.connected()) {
      if (y >= 250) {
        showAgents();
      }
      return;
    }
    if (x >= kNewThreadCardX &&
        x < kNewThreadCardX + kNewThreadCardWidth &&
        y >= kNewThreadCardY &&
        y < kNewThreadCardY + kNewThreadCardHeight) {
      createThread();
      return;
    }
    if (x < kThreadCardX || x >= kThreadCardX + kThreadCardWidth ||
        y < kThreadCardY) {
      return;
    }
    const int visibleIndex = (y - kThreadCardY) / kThreadCardPitch;
    if (visibleIndex < 0 || visibleIndex >= kThreadsPerPage) {
      return;
    }
    const int cardY = kThreadCardY + visibleIndex * kThreadCardPitch;
    if (y >= cardY + kThreadCardHeight) {
      return;
    }
    openThread(_threadOffset + visibleIndex);
    return;
  }
  if (_view == View::Agents) {
    if (_client.pairingPending() || y < 124 || y >= 400) {
      return;
    }
    const int visibleIndex = (y - 124) / 66;
    if (visibleIndex < 0 || visibleIndex >= kAgentsPerPage) {
      return;
    }
    _agentFocusIndex = _agentPage * kAgentsPerPage + visibleIndex;
    _client.selectAgent(_agentFocusIndex);
    return;
  }
  if (x < 58 && y >= 56 && y <= 112 && !_recording) {
    backToThreads();
    return;
  }
  if (x >= 16 && x < 352 && y >= kMessageCardY &&
      y < kMessageCardY + kMessageCardHeight && !_recording &&
      !_awaitingResponse) {
    toggleAssistantSpeech();
  }
}

void RemoteApp::pageForward() {
  if (_view == View::Threads) {
    const int lastThreadOffset =
        max(0, _client.threadCount() - kThreadsPerPage);
    _threadOffset =
        min(lastThreadOffset, _threadOffset + kThreadScrollStep);
    _dirty = true;
    return;
  }
  if (_view == View::Agents) {
    const int lastPage =
        max(0, (_client.agentCount() + kAgentsPerPage - 1) /
                       kAgentsPerPage -
                   1);
    _agentPage = min(lastPage, _agentPage + 1);
    _agentFocusIndex = _client.agentCount() == 0
                            ? 0
                            : min(_client.agentCount() - 1,
                                  _agentPage * kAgentsPerPage);
    _dirty = true;
    return;
  }
  if (_awaitingResponse) {
    return;
  }
  const int index = readerMessageIndex();
  if (index < 0) {
    return;
  }
  const RemoteMessage &message = _client.message(index);
  if (_readerPage + 1 < messagePageCount(message)) {
    _readerPage++;
  } else if (index + 1 < _client.messageCount()) {
    _readerMessageId = _client.message(index + 1).id;
    _readerPage = 0;
  }
  _dirty = true;
}

void RemoteApp::pageBack() {
  if (_view == View::Threads) {
    const int lastThreadOffset =
        max(0, _client.threadCount() - kThreadsPerPage);
    if (_threadOffset == lastThreadOffset &&
        lastThreadOffset % kThreadScrollStep != 0) {
      _threadOffset = (lastThreadOffset / kThreadScrollStep) *
                      kThreadScrollStep;
    } else {
      _threadOffset = max(0, _threadOffset - kThreadScrollStep);
    }
    _dirty = true;
    return;
  }
  if (_view == View::Agents) {
    _agentPage = max(0, _agentPage - 1);
    _agentFocusIndex = _client.agentCount() == 0
                            ? 0
                            : min(_client.agentCount() - 1,
                                  _agentPage * kAgentsPerPage);
    _dirty = true;
    return;
  }
  if (_awaitingResponse) {
    return;
  }
  const int index = readerMessageIndex();
  if (index < 0) {
    return;
  }
  if (_readerPage > 0) {
    _readerPage--;
  } else if (index > 0) {
    const RemoteMessage &previous = _client.message(index - 1);
    _readerMessageId = previous.id;
    _readerPage = messagePageCount(previous) - 1;
  }
  _dirty = true;
}

void RemoteApp::openThread(int index) {
  if (index < 0 || index >= _client.threadCount()) {
    return;
  }
  const RemoteThread &thread = _client.thread(index);
  _client.clearActiveThread();
  if (!_client.openThread(thread.id)) {
    return;
  }
  _readerMessageId = "";
  _readerPage = 0;
  _awaitingResponse = false;
  _view = View::Conversation;
  _dirty = true;
}

void RemoteApp::createThread() {
  _client.clearActiveThread();
  if (!_client.createThread()) {
    return;
  }
  _readerMessageId = "";
  _readerPage = 0;
  _awaitingResponse = false;
  _view = View::Conversation;
  _dirty = true;
}

void RemoteApp::backToThreads() {
  _audio.stopPlayback();
  _playbackActive = false;
  _ignoreRemoteAudio = true;
  _view = View::Threads;
  _awaitingResponse = false;
  _client.listThreads();
  _dirty = true;
}

void RemoteApp::backFromAgents() {
  if (_client.pairingPending()) {
    _client.cancelPairing();
    _dirty = true;
    return;
  }
  _client.endAgentSelection();
  _view = View::Threads;
  if (_client.connected()) {
    _client.listThreads();
  }
  _dirty = true;
}

void RemoteApp::showAgents() {
  _view = View::Agents;
  _agentPage = 0;
  _dirty = true;
  draw();
  _client.beginAgentSelection();
  _agentFocusIndex = 0;
  for (int index = 0; index < _client.agentCount(); index++) {
    if (_client.agent(index).selected) {
      _agentFocusIndex = index;
      _agentPage = index / kAgentsPerPage;
      break;
    }
  }
  _dirty = true;
}

void RemoteApp::confirmAgent() {
  if (_client.pairingPending()) {
    _client.checkPairing();
    return;
  }
  if (_client.agentCount() == 0) {
    _client.refreshDiscovery();
    if (_client.hostCount() > 0) {
      _client.pairHost(0);
    }
    return;
  }
  _agentFocusIndex = constrain(_agentFocusIndex, 0,
                               _client.agentCount() - 1);
  _client.selectAgent(_agentFocusIndex);
}

void RemoteApp::startRecording() {
  if (!_client.connected() || _client.activeThreadId().isEmpty()) {
    return;
  }
  _audio.stopPlayback();
  _playbackActive = false;
  _ignoreRemoteAudio = true;
  if (!_audio.startRecording()) {
    return;
  }
  if (!_client.startAudio(_client.activeThreadId())) {
    _audio.stopRecording();
    return;
  }
  _recording = true;
  _dirty = true;
}

void RemoteApp::stopRecording() {
  _recording = false;
  _audio.stopRecording();
  _ignoreRemoteAudio = false;
  _responseBaselineId = latestAssistantId();
  _readerMessageId = "";
  _readerPage = 0;
  _awaitingResponse = true;
  _client.endAudio();
  _dirty = true;
}

void RemoteApp::cancelRecording() {
  _recording = false;
  _audio.stopRecording();
  _client.cancelAudio();
  _awaitingResponse = false;
  _dirty = true;
}

void RemoteApp::toggleAssistantSpeech() {
  if (_playbackActive) {
    _audio.stopPlayback();
    _playbackActive = false;
    _ignoreRemoteAudio = true;
    _dirty = true;
    return;
  }
  const int index = readerMessageIndex();
  if (index < 0) return;
  const RemoteMessage &message = _client.message(index);
  if (message.role != "assistant" || _client.activeThreadId().isEmpty()) return;
  _ignoreRemoteAudio = false;
  _client.speakMessage(_client.activeThreadId(), message.id);
}

void RemoteApp::updateReaderSelection() {
  if (_view != View::Conversation) {
    return;
  }
  if (!_client.error().isEmpty()) {
    _awaitingResponse = false;
  }
  if (_awaitingResponse) {
    for (int index = _client.messageCount() - 1; index >= 0; index--) {
      const RemoteMessage &message = _client.message(index);
      if (message.role == "assistant" && message.id != _responseBaselineId) {
        _readerMessageId = message.id;
        _readerPage = 0;
        _awaitingResponse = false;
        return;
      }
    }
    return;
  }

  int index = readerMessageIndex();
  if (index < 0 && _client.messageCount() > 0) {
    index = _client.messageCount() - 1;
    const RemoteMessage &message = _client.message(index);
    _readerMessageId = message.id;
    _readerPage = messagePageCount(message) - 1;
  } else if (index >= 0) {
    _readerPage =
        constrain(_readerPage, 0, messagePageCount(_client.message(index)) - 1);
  }
}

int RemoteApp::readerMessageIndex() const {
  for (int index = 0; index < _client.messageCount(); index++) {
    if (_client.message(index).id == _readerMessageId) {
      return index;
    }
  }
  return -1;
}

int RemoteApp::messagePageCount(const RemoteMessage &message) const {
  const int lines = max(1, wrappedLineCount(message.text,
                                            kMessageCharactersPerLine));
  return max(1, (lines + kMessageLinesPerPage - 1) / kMessageLinesPerPage);
}

String RemoteApp::latestAssistantId() const {
  for (int index = _client.messageCount() - 1; index >= 0; index--) {
    if (_client.message(index).role == "assistant") {
      return _client.message(index).id;
    }
  }
  return "";
}

void RemoteApp::draw() {
  Arduino_GFX &display = Board::display();
  display.fillScreen(kBlack);
  drawHeader();
  if (_view == View::Threads) {
    drawThreads();
  } else if (_view == View::Conversation) {
    drawConversation();
  } else {
    drawAgents();
  }
  Board::flushDisplay();
  _lastDrawMs = millis();
  _dirty = false;
}

void RemoteApp::drawAnimationFrame() {
  if (_view != View::Conversation || _client.activeThreadId().isEmpty()) {
    return;
  }

  Arduino_GFX &display = Board::display();
  if (_recording) {
    redrawWaveform(display, 306);
  } else if (_awaitingResponse) {
    redrawWaveform(display, 278);
  }
  Board::flushDisplay();
  _lastDrawMs = millis();
}

void RemoteApp::handleSerialDebug() {
  while (Serial.available() > 0) {
    const char value = static_cast<char>(Serial.read());
    if (value == '\r') {
      continue;
    }
    if (value != '\n') {
      if (_serialCommand.length() < 32) {
        _serialCommand += value;
      }
      continue;
    }
    if (_serialCommand == "$SCREENSHOT") {
      Board::writeDisplayScreenshot(Serial);
    } else if (_serialCommand == "$PAGE_BACK") {
      pageBack();
    } else if (_serialCommand == "$PAGE_FORWARD") {
      pageForward();
    } else if (_serialCommand.startsWith("$TAP ")) {
      const int separator = _serialCommand.indexOf(' ', 5);
      if (separator > 5) {
        const int x = _serialCommand.substring(5, separator).toInt();
        const int y = _serialCommand.substring(separator + 1).toInt();
        handleTap(x, y);
      }
    }
    _serialCommand = "";
  }
}

void RemoteApp::drawHeader() {
  Arduino_GFX &display = Board::display();
  display.setTextSize(3);
  display.setTextColor(kWhite);
  display.setCursor(16, 18);
  String headerName = "Codex Remote";
  if (_view == View::Agents) {
    headerName = _client.agentCount() > 0 ? "Choose agent" : "Pair host";
  } else if (_view == View::Conversation &&
             !_client.selectedAgentName().isEmpty()) {
    headerName = _client.selectedAgentName();
  }
  display.print(headerName.substring(0, 15));
  const bool wifiConnected = WiFi.status() == WL_CONNECTED;
  drawWifiIcon(display, 288, 27, wifiConnected ? kCyan : kCoral);
  drawBatteryIcon(display, 326, 20);
}

void RemoteApp::drawThreads() {
  Arduino_GFX &display = Board::display();
  if (!_client.connected()) {
    const bool wifiConnected = WiFi.status() == WL_CONNECTED;
    const bool hostFound = wifiConnected && _client.hostCount() > 0;
    drawOrb(display, SCREEN_WIDTH_PX / 2, 142, 55, true);
    drawCenteredText(display,
                     hostFound ? "HOST FOUND"
                              : (wifiConnected ? "WI-FI READY"
                                               : "JOINING WI-FI"),
                     213, 3,
                     wifiConnected ? kMint : kYellow);
    if (wifiConnected) {
      drawCenteredText(display, WiFi.localIP().toString(), 247, 2, kMuted);
    } else if (!_client.error().isEmpty()) {
      drawCenteredText(display, _client.error().substring(0, 28), 247, 2,
                       kCoral);
    }

    display.fillRoundRect(20, 276, 328, 104, 17, kPanel);
    display.drawRoundRect(20, 276, 328, 104, 17, kPanelGlow);
    display.fillCircle(64, 325, 27, 0x0868);
    drawHostIcon(display, 64, 325, kCyan);
    display.setTextSize(2);
    display.setTextColor(kWhite);
    display.setCursor(103, 294);
    display.print(hostFound ? "Host found" : "Waiting for host");
    display.setTextSize(2);
    display.setTextColor(kMuted);
    display.setCursor(103, 324);
    if (_client.agentCount() > 0) {
      display.print(String(_client.agentCount()) +
                    (_client.agentCount() == 1 ? " AGENT AVAILABLE"
                                               : " AGENTS AVAILABLE"));
    } else if (hostFound) {
      display.print("NOT PAIRED");
    } else {
      display.print("OPEN DESKTOP APP");
    }
    if (!hostFound || _client.agentCount() > 0) {
      display.setCursor(103, 348);
      display.print(hostFound ? "CHOOSE AGENT" : "SAME WI-FI");
    }
    drawChevron(display, 326, 326, kMint);
    drawFooter(_client.agentCount() > 0 ? "PWR CHOOSE AGENT"
                                        : "PWR PAIR HOST");
    return;
  }

  const int newThreadCenterY = kNewThreadCardY + kNewThreadCardHeight / 2;
  display.fillRoundRect(kNewThreadCardX, kNewThreadCardY,
                        kNewThreadCardWidth, kNewThreadCardHeight, 18,
                        kPanelSelected);
  display.drawRoundRect(kNewThreadCardX, kNewThreadCardY,
                        kNewThreadCardWidth, kNewThreadCardHeight, 18, kCyan);
  display.drawRoundRect(kNewThreadCardX + 2, kNewThreadCardY + 2,
                        kNewThreadCardWidth - 4, kNewThreadCardHeight - 4, 16,
                        kPanelGlow);
  display.fillCircle(46, newThreadCenterY, 21, 0x0868);
  drawMicrophone(display, 46, newThreadCenterY - 3, kWhite);
  display.setFont(u8g2_font_helvB18_tf);
  display.setTextSize(1);
  display.setTextColor(kWhite);
  display.setCursor(78, kNewThreadCardY + 30);
  display.print("NEW THREAD");
  display.setFont();
  display.setTextSize(2);
  display.setTextColor(kMint);
  display.setCursor(78, kNewThreadCardY + 43);
  display.print("PRESS PWR");
  drawChevron(display, 334, newThreadCenterY, kMint);

  const int first = _threadOffset;
  const int last = min(_client.threadCount(), first + kThreadsPerPage);
  display.setTextSize(2);
  display.setTextColor(kMuted);
  display.setCursor(18, 64);
  if (_client.threadCount() == 0) {
    display.print("NO THREADS YET");
  } else {
    const String page = String(first + 1) + "-" + String(last) + " OF " +
                        String(_client.threadCount()) + " THREADS";
    display.print(page);
  }

  for (int visible = 0; visible < kThreadsPerPage; visible++) {
    const int index = first + visible;
    if (index >= _client.threadCount()) {
      break;
    }
    const int y = kThreadCardY + visible * kThreadCardPitch;
    display.fillRoundRect(kThreadCardX, y, kThreadCardWidth,
                          kThreadCardHeight, 10, kPanel);
    display.drawRoundRect(kThreadCardX, y, kThreadCardWidth,
                          kThreadCardHeight, 10, kLine);
    const int centerY = y + kThreadCardHeight / 2;
    display.fillCircle(39, centerY, 16, 0x180B);
    drawSpark(display, 39, centerY, 8, kViolet);
    display.setFont(u8g2_font_helvB24_tf);
    display.setTextSize(1);
    display.setTextColor(kWhite);
    display.setCursor(65, y + 46);
    display.print(fitTextToWidth(display, _client.thread(index).title, 247));
    display.setFont();
    drawChevron(display, 336, centerY, kMint);
  }
}

void RemoteApp::drawAgents() {
  Arduino_GFX &display = Board::display();
  if (_client.pairingPending()) {
    drawOrb(display, SCREEN_WIDTH_PX / 2, 106, 31, true);
    drawCenteredText(display, "PAIR WITH HOST", 150, 3, kMint);
    drawCenteredText(display, _client.selectedHostName().substring(0, 26),
                     180, 2, kMuted);
    display.fillRoundRect(24, 208, 320, 137, 18, kPanel);
    display.drawRoundRect(24, 208, 320, 137, 18, kCyan);
    drawCenteredText(display, "CONFIRM CODE", 228, 2, kMuted);
    display.setTextSize(4);
    display.setTextColor(kWhite);
    const int codeWidth = _client.pairingCode().length() * 24;
    display.setCursor((SCREEN_WIDTH_PX - codeWidth) / 2, 258);
    display.print(_client.pairingCode().substring(0, 6));
    drawCenteredText(display, "APPROVE IN HOST APP", 318, 2, kMuted);
    drawFooter("PWR CHECK  BOOT CANCEL");
    return;
  }

  const int first = _agentPage * kAgentsPerPage;
  const int last = min(_client.agentCount(), first + kAgentsPerPage);
  if (_client.agentCount() == 0) {
    drawOrb(display, SCREEN_WIDTH_PX / 2, 143, 56, true);
    drawCenteredText(display,
                     _client.hostCount() > 0 ? "PAIR HOST"
                                             : "WAITING FOR HOST",
                     211, 3, kMint);
    display.fillRoundRect(24, 261, 320, 104, 17, kPanel);
    display.drawRoundRect(24, 261, 320, 104, 17, kPanelGlow);
    display.fillCircle(65, 313, 25, 0x0868);
    drawHostIcon(display, 65, 313, kCyan);
    display.setTextSize(2);
    display.setTextColor(kWhite);
    display.setCursor(103, 280);
    display.print(_client.hostCount() > 0 ? "Host found" : "No host yet");
    display.setTextSize(2);
    display.setTextColor(kMuted);
    display.setCursor(103, 310);
    display.print(_client.hostCount() > 0 ? "OPEN PAIRING IN APP"
                                         : "OPEN DESKTOP APP");
    display.setCursor(103, 336);
    display.print(WiFi.localIP().toString());
    drawFooter(_client.hostCount() > 0 ? "WAITING  BOOT BACK"
                                       : "PWR REFRESH  BOOT BACK");
    return;
  }

  display.setTextSize(2);
  display.setTextColor(kMuted);
  display.setCursor(18, 75);
  display.printf("%d-%d / %d AVAILABLE", first + 1, last,
                 _client.agentCount());
  for (int visible = 0; visible < kAgentsPerPage; visible++) {
    const int index = first + visible;
    if (index >= _client.agentCount()) {
      break;
    }
    const RemoteAgent &agent = _client.agent(index);
    const int y = 124 + visible * 66;
    display.fillRoundRect(16, y, 336, 58, 13, kPanel);
    display.drawRoundRect(
        16, y, 336, 58, 13,
        index == _agentFocusIndex
            ? kCyan
            : (agent.paired ? kPanelGlow : kLine));
    const uint16_t iconColor = agent.paired ? kMint : kMuted;
    display.fillCircle(48, y + 29, 21, agent.paired ? 0x0868 : 0x1083);
    drawHostIcon(display, 48, y + 28, iconColor);
    display.setTextSize(4);
    display.setTextColor(kWhite);
    display.setCursor(80, y + 14);
    display.print(agent.name.substring(0, 10));
    drawChevron(display, 332, y + 29, kMint);
  }
  drawFooter("PWR SELECT  BOOT BACK");
}

void RemoteApp::drawConversation() {
  Arduino_GFX &display = Board::display();
  display.fillCircle(34, 82, 20, kPanel);
  display.drawCircle(34, 82, 20, kCyan);
  display.drawLine(39, 71, 28, 82, kWhite);
  display.drawLine(28, 82, 39, 93, kWhite);

  if (_client.activeThreadId().isEmpty()) {
    drawOrb(display, SCREEN_WIDTH_PX / 2, 210, 58, true);
    drawCenteredText(display, "LOADING THREAD", 280, 3, kMint);
    drawFooter("BOOT BACK");
    return;
  }

  display.setFont(u8g2_font_helvB18_tf);
  display.setTextSize(1);
  display.setTextColor(kWhite);
  display.setCursor(64, 92);
  display.print(fitTextToWidth(display, _client.activeThreadTitle(), 282));
  display.setFont();
  display.setTextSize(2);

  if (_recording) {
    drawOrb(display, SCREEN_WIDTH_PX / 2, 185, 75, true);
    drawWaveform(display, 306, true);
    drawCenteredText(display, "LISTENING...", 342, 3, kMint);
    drawCenteredText(display, "PWR SEND  BOOT CANCEL", 375, 2, kWhite);
    drawFooter("RECORDING");
    return;
  }

  if (_awaitingResponse) {
    drawOrb(display, SCREEN_WIDTH_PX / 2, 176, 48, true);
    drawWaveform(display, 278, true);
    drawCenteredText(display, "CODEX IS THINKING", 321, 3, kMint);
    drawCenteredText(display, "REQUEST SENT", 356, 2, kMuted);
    drawFooter("BOOT BACK");
    return;
  }

  const int index = readerMessageIndex();
  if (index < 0) {
    display.fillCircle(SCREEN_WIDTH_PX / 2, 218, 61, kPanel);
    display.fillArc(SCREEN_WIDTH_PX / 2, 218, 63, 60, 135, 315, kCyan);
    display.fillArc(SCREEN_WIDTH_PX / 2, 218, 63, 60, 315, 360, kViolet);
    display.fillArc(SCREEN_WIDTH_PX / 2, 218, 63, 60, 0, 135, kViolet);
    drawMicrophone(display, SCREEN_WIDTH_PX / 2, 212, kWhite);
    drawCenteredText(display, "PRESS PWR", 298, 3, kMint);
    drawCenteredText(display, "TO START RECORDING", 333, 2, kMuted);
    drawFooter("BOOT BACK");
    return;
  }

  const RemoteMessage &message = _client.message(index);
  const int pageCount = messagePageCount(message);
  const String position = String(index + 1) + "/" +
                          String(_client.messageCount()) + "  PAGE " +
                          String(_readerPage + 1) + "/" + String(pageCount);
  display.setTextColor(kMuted);
  display.setCursor(SCREEN_WIDTH_PX - 16 - position.length() * 12,
                    kMessagePositionY);
  display.print(position);

  const bool user = message.role == "user";
  display.fillRoundRect(16, kMessageCardY, 336, kMessageCardHeight, 17,
                        user ? kPanelSelected : kPanel);
  display.drawRoundRect(16, kMessageCardY, 336, kMessageCardHeight, 17,
                        user ? kBlue : kPanelGlow);
  display.fillCircle(43, kMessageHeaderCenterY, 18,
                     user ? 0x10A5 : 0x0868);
  if (user) {
    drawMicrophone(display, 43, kMessageHeaderCenterY - 3, kCyan);
  } else {
    drawSpark(display, 43, kMessageHeaderCenterY, 10, kMint);
  }
  display.setFont(u8g2_font_helvB14_tf);
  display.setTextSize(1);
  display.setTextColor(user ? kCyan : kMint);
  display.setCursor(70, kMessageHeaderBaselineY);
  display.print(user ? "YOU SAID" : "CODEX REPLY");
  if (_readerPage > 0) {
    display.setTextColor(kMuted);
    display.print("  CONTINUED");
  }
  if (message.status == "streaming") {
    display.setTextColor(kMint);
    display.print("  *");
  }
  display.setFont();
  drawMessageTextPage(message.text, _readerPage, 30,
                      kMessageTextBaselineY,
                      kMessageCharactersPerLine, kMessageLinesPerPage,
                      user ? kCyan : kWhite);
  if (!user) {
    drawFooter(_playbackActive ? "TAP STOP  PWR TALK"
                               : "TAP READ  PWR TALK");
  } else {
    drawFooter("PWR TALK  BOOT BACK");
  }
}

void RemoteApp::drawFooter(const char *label) {
  Arduino_GFX &display = Board::display();
  display.fillRoundRect(20, 402, 328, 38, 18, kPanel);
  display.setFont(u8g2_font_helvB12_tf);
  display.setTextSize(1);
  display.setTextColor(kMuted);
  int16_t x1 = 0;
  int16_t y1 = 0;
  uint16_t width = 0;
  uint16_t height = 0;
  display.getTextBounds(label, 0, 0, &x1, &y1, &width, &height);
  display.setCursor(max(3, (SCREEN_WIDTH_PX - static_cast<int>(width)) / 2),
                    427);
  display.print(label);
  display.setFont();
}

void RemoteApp::drawMessageTextPage(const String &text, int page, int x, int y,
                                    int charactersPerLine, int linesPerPage,
                                    uint16_t color) {
  Arduino_GFX &display = Board::display();
  display.setFont(u8g2_font_helvR24_tf);
  display.setTextSize(1);
  display.setTextColor(color);
  int offset = 0;
  int wrappedLine = 0;
  const int firstLine = page * linesPerPage;
  while (offset < text.length() && wrappedLine < firstLine + linesPerPage) {
    const int newline = text.indexOf('\n', offset);
    const int paragraphEnd = newline >= 0 ? newline : text.length();
    if (paragraphEnd == offset) {
      if (wrappedLine >= firstLine) {
        y += kMessageLineHeight;
      }
      wrappedLine++;
      offset++;
      continue;
    }

    int length = min(charactersPerLine, paragraphEnd - offset);
    int split = length;
    if (offset + length < paragraphEnd) {
      while (split > 1 && text[offset + split] != ' ' &&
             text[offset + split] != '\t') {
        split--;
      }
      if (split <= 1) {
        split = length;
      }
    }
    if (wrappedLine >= firstLine) {
      display.setCursor(x, y);
      display.print(text.substring(offset, offset + split));
      y += kMessageLineHeight;
    }
    wrappedLine++;
    offset += split;
    while (offset < paragraphEnd &&
           (text[offset] == ' ' || text[offset] == '\t')) {
      offset++;
    }
    if (offset >= paragraphEnd && newline >= 0) {
      offset = newline + 1;
    }
  }
  display.setFont();
}

int RemoteApp::wrappedLineCount(const String &text,
                                int charactersPerLine) const {
  if (text.isEmpty()) {
    return 1;
  }
  int lines = 0;
  int offset = 0;
  while (offset < text.length()) {
    const int newline = text.indexOf('\n', offset);
    const int paragraphEnd = newline >= 0 ? newline : text.length();
    if (paragraphEnd == offset) {
      lines++;
      offset++;
      continue;
    }
    int length = min(charactersPerLine, paragraphEnd - offset);
    int split = length;
    if (offset + length < paragraphEnd) {
      while (split > 1 && text[offset + split] != ' ' &&
             text[offset + split] != '\t') {
        split--;
      }
      if (split <= 1) {
        split = length;
      }
    }
    lines++;
    offset += split;
    while (offset < paragraphEnd &&
           (text[offset] == ' ' || text[offset] == '\t')) {
      offset++;
    }
    if (offset >= paragraphEnd && newline >= 0) {
      offset = newline + 1;
    }
  }
  return max(1, lines);
}
