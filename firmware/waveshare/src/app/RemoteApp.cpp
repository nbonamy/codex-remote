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
constexpr int kThreadsPerPage = 2;
constexpr int kBridgesPerPage = 4;
constexpr int kMessageCharactersPerLine = 25;
constexpr int kMessageLinesPerPage = 13;
constexpr int kSwipeThresholdPx = 48;

void drawCenteredText(Arduino_GFX &display, const String &text, int y,
                      uint8_t size, uint16_t color) {
  display.setTextSize(size);
  display.setTextColor(color);
  const int width = text.length() * 6 * size;
  display.setCursor(max(0, (SCREEN_WIDTH_PX - width) / 2), y);
  display.print(text);
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
    }
  }
  const bool animationActive = _recording || _awaitingResponse;
  if (_dirty || (animationActive && millis() - _lastDrawMs > 180)) {
    draw();
  }
  delay(2);
}

void RemoteApp::onRemoteStateChanged() {
  const int lastPage =
      max(0, (_client.threadCount() + kThreadsPerPage - 1) / kThreadsPerPage - 1);
  _threadPage = min(_threadPage, lastPage);
  const int lastBridgePage =
      max(0, (_client.bridgeCount() + kBridgesPerPage - 1) /
                     kBridgesPerPage -
                 1);
  _bridgePage = min(_bridgePage, lastBridgePage);
  if (_client.pairingPending()) {
    _view = View::Bridges;
  }
  if (_view == View::Bridges && _client.connected()) {
    _view = View::Threads;
  }
  updateReaderSelection();
  _dirty = true;
}

void RemoteApp::onRemoteAudio(const uint8_t *data, size_t length) {
  if (_recording) {
    return;
  }
  if (!_playbackActive) {
    _audio.resetPlayback();
    _audio.markPlaybackStarted();
    _playbackActive = true;
  }
  if (!_audio.queuePlayback(data, length)) {
    Log::client("App", "speaker buffer overflow");
  }
}

void RemoteApp::handleButtons() {
  const bool buttonA = Board::buttonAIsPressed();
  const bool buttonB = Board::buttonBIsPressed();

  if (_view == View::Threads) {
    if (buttonA && !_buttonAPrevious) {
      createThread();
    }
    if (buttonB && !_buttonBPrevious) {
      showBridges();
    }
  } else if (_view == View::Conversation) {
    if (buttonA && !_buttonAPrevious) {
      startRecording();
    }
    if (!buttonA && _buttonAPrevious && _recording) {
      stopRecording();
    }
  } else {
    if (buttonA && !_buttonAPrevious && !_client.pairingPending()) {
      _client.refreshBridges();
    }
  }

  _buttonAPrevious = buttonA;
  _buttonBPrevious = buttonB;
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
      pageForward();
    } else {
      pageBack();
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
        showBridges();
      }
      return;
    }
    if (x >= 28 && x < 340 && y >= 190 && y < 290) {
      createThread();
      return;
    }
    if (y < 316 || y >= 432) {
      return;
    }
    const int visibleIndex = (y - 316) / 58;
    if (visibleIndex < 0 || visibleIndex >= kThreadsPerPage) {
      return;
    }
    openThread(_threadPage * kThreadsPerPage + visibleIndex);
    return;
  }
  if (_view == View::Bridges) {
    if (_client.pairingPending() || y < 124 || y >= 400) {
      return;
    }
    const int visibleIndex = (y - 124) / 66;
    if (visibleIndex < 0 || visibleIndex >= kBridgesPerPage) {
      return;
    }
    _client.selectBridge(_bridgePage * kBridgesPerPage + visibleIndex);
    return;
  }
  if (x < 58 && y >= 56 && y <= 112 && !_recording) {
    backToThreads();
  }
}

void RemoteApp::pageForward() {
  if (_view == View::Threads) {
    const int lastPage =
        max(0, (_client.threadCount() + kThreadsPerPage - 1) / kThreadsPerPage - 1);
    _threadPage = min(lastPage, _threadPage + 1);
    _dirty = true;
    return;
  }
  if (_view == View::Bridges) {
    const int lastPage =
        max(0, (_client.bridgeCount() + kBridgesPerPage - 1) /
                       kBridgesPerPage -
                   1);
    _bridgePage = min(lastPage, _bridgePage + 1);
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
    _threadPage = max(0, _threadPage - 1);
    _dirty = true;
    return;
  }
  if (_view == View::Bridges) {
    _bridgePage = max(0, _bridgePage - 1);
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
  _view = View::Threads;
  _awaitingResponse = false;
  _client.listThreads();
  _dirty = true;
}

void RemoteApp::showBridges() {
  _view = View::Bridges;
  _bridgePage = 0;
  _client.beginBridgeSelection();
  _dirty = true;
}

void RemoteApp::startRecording() {
  if (!_client.connected() || _client.activeThreadId().isEmpty()) {
    return;
  }
  _audio.stopPlayback();
  _playbackActive = false;
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
  _responseBaselineId = latestAssistantId();
  _readerMessageId = "";
  _readerPage = 0;
  _awaitingResponse = true;
  _client.endAudio();
  _dirty = true;
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
    drawBridges();
  }
  _lastDrawMs = millis();
  _dirty = false;
}

void RemoteApp::drawHeader() {
  Arduino_GFX &display = Board::display();
  display.setTextSize(2);
  display.setTextColor(kWhite);
  display.setCursor(16, 18);
  String headerName = "Codex Remote";
  if (_view == View::Bridges) {
    headerName = "Choose host";
  } else if (_view == View::Conversation &&
             !_client.selectedHostName().isEmpty()) {
    headerName = _client.selectedHostName();
  }
  display.print(headerName.substring(0, 19));
  const bool wifiConnected = WiFi.status() == WL_CONNECTED;
  drawWifiIcon(display, 288, 27, wifiConnected ? kCyan : kCoral);
  drawBatteryIcon(display, 326, 20);
}

void RemoteApp::drawThreads() {
  Arduino_GFX &display = Board::display();
  if (!_client.connected()) {
    const bool wifiConnected = WiFi.status() == WL_CONNECTED;
    drawOrb(display, SCREEN_WIDTH_PX / 2, 142, 55, true);
    drawCenteredText(display, wifiConnected ? "WI-FI READY" : "JOINING WI-FI",
                     213, 2, wifiConnected ? kMint : kYellow);
    if (wifiConnected) {
      drawCenteredText(display, WiFi.localIP().toString(), 239, 1, kMuted);
    } else if (!_client.error().isEmpty()) {
      drawCenteredText(display, _client.error().substring(0, 48), 239, 1,
                       kCoral);
    }

    display.fillRoundRect(20, 276, 328, 104, 17, kPanel);
    display.drawRoundRect(20, 276, 328, 104, 17, kPanelGlow);
    display.fillCircle(64, 325, 27, 0x0868);
    drawHostIcon(display, 64, 325, kCyan);
    display.setTextSize(2);
    display.setTextColor(kWhite);
    display.setCursor(103, 294);
    display.print("Waiting for Mac");
    display.setTextSize(1);
    display.setTextColor(kMuted);
    display.setCursor(103, 326);
    display.print("Open Codex Remote");
    display.setCursor(103, 344);
    display.print("on this network");
    drawChevron(display, 326, 326, kMint);
    drawFooter("PWR or tap  Choose host");
    return;
  }

  drawOrb(display, SCREEN_WIDTH_PX / 2, 112, 34, false);
  drawCenteredText(display, "READY", 158, 2, kMint);

  display.fillRoundRect(28, 190, 312, 100, 18, kPanelSelected);
  display.drawRoundRect(28, 190, 312, 100, 18, kCyan);
  display.drawRoundRect(30, 192, 308, 96, 16, kPanelGlow);
  drawMicrophone(display, 76, 232, kWhite);
  display.setTextSize(2);
  display.setTextColor(kWhite);
  display.setCursor(112, 210);
  display.print("NEW THREAD");
  display.setTextSize(1);
  display.setTextColor(kMint);
  display.setCursor(112, 248);
  display.print("PRESS BOOT TO START");
  display.setTextColor(kMuted);
  display.setCursor(112, 269);
  display.print("or tap this card");

  const int first = _threadPage * kThreadsPerPage;
  const int last = min(_client.threadCount(), first + kThreadsPerPage);
  display.setTextSize(1);
  display.setTextColor(kWhite);
  display.setCursor(18, 305);
  display.print("RECENT");
  if (_client.threadCount() == 0) {
    display.setTextColor(kMuted);
    display.setCursor(254, 305);
    display.print("NO THREADS YET");
  } else {
    const String page = String(first + 1) + "-" + String(last) + " / " +
                        String(_client.threadCount());
    display.setTextColor(kMuted);
    display.setCursor(SCREEN_WIDTH_PX - 18 - page.length() * 6, 305);
    display.print(page);
  }

  for (int visible = 0; visible < kThreadsPerPage; visible++) {
    const int index = first + visible;
    if (index >= _client.threadCount()) {
      break;
    }
    const int y = 316 + visible * 58;
    display.fillRoundRect(16, y, 336, 50, 12, kPanel);
    display.drawRoundRect(16, y, 336, 50, 12, kLine);
    display.fillCircle(43, y + 25, 18, visible == 0 ? 0x0868 : 0x180B);
    display.setTextColor(visible == 0 ? kCyan : kViolet);
    display.setCursor(32, y + 21);
    display.print("</>");
    display.setTextColor(kWhite);
    display.setCursor(70, y + 8);
    display.print(_client.thread(index).title.substring(0, 38));
    display.setTextColor(kMuted);
    display.setCursor(70, y + 28);
    display.print(_client.thread(index).preview.substring(0, 39));
    drawChevron(display, 334, y + 25, kMint);
  }
}

void RemoteApp::drawBridges() {
  Arduino_GFX &display = Board::display();
  if (_client.pairingPending()) {
    drawOrb(display, SCREEN_WIDTH_PX / 2, 106, 31, true);
    drawCenteredText(display, "PAIR WITH MAC", 154, 2, kMint);
    drawCenteredText(display, _client.selectedBridgeName().substring(0, 38),
                     180, 1, kMuted);
    display.fillRoundRect(24, 208, 320, 137, 18, kPanel);
    display.drawRoundRect(24, 208, 320, 137, 18, kCyan);
    drawCenteredText(display, "CONFIRM THIS CODE", 230, 1, kMuted);
    display.setTextSize(4);
    display.setTextColor(kWhite);
    const int codeWidth = _client.pairingCode().length() * 24;
    display.setCursor((SCREEN_WIDTH_PX - codeWidth) / 2, 258);
    display.print(_client.pairingCode().substring(0, 6));
    drawCenteredText(display, "Approve in the Mac menu bar", 318, 1, kMuted);
    drawFooter("Matching codes keep pairing private");
    return;
  }

  const int first = _bridgePage * kBridgesPerPage;
  const int last = min(_client.bridgeCount(), first + kBridgesPerPage);
  if (_client.bridgeCount() == 0) {
    drawOrb(display, SCREEN_WIDTH_PX / 2, 143, 56, true);
    drawCenteredText(display, "WAITING FOR MAC", 215, 2, kMint);
    display.fillRoundRect(24, 261, 320, 104, 17, kPanel);
    display.drawRoundRect(24, 261, 320, 104, 17, kPanelGlow);
    display.fillCircle(65, 313, 25, 0x0868);
    drawHostIcon(display, 65, 313, kCyan);
    display.setTextSize(2);
    display.setTextColor(kWhite);
    display.setCursor(103, 280);
    display.print("No hosts yet");
    display.setTextSize(1);
    display.setTextColor(kMuted);
    display.setCursor(103, 315);
    display.print("Open the Mac app");
    display.setCursor(103, 335);
    display.print(WiFi.localIP().toString());
    drawFooter("BOOT  Refresh hosts");
    return;
  }

  display.setTextSize(1);
  display.setTextColor(kMuted);
  display.setCursor(18, 75);
  display.printf("%d-%d / %d AVAILABLE", first + 1, last,
                 _client.bridgeCount());
  for (int visible = 0; visible < kBridgesPerPage; visible++) {
    const int index = first + visible;
    if (index >= _client.bridgeCount()) {
      break;
    }
    const RemoteBridge &bridge = _client.bridge(index);
    const int y = 124 + visible * 66;
    display.fillRoundRect(16, y, 336, 58, 13, kPanel);
    display.drawRoundRect(16, y, 336, 58, 13,
                          bridge.paired ? kPanelGlow : kLine);
    const uint16_t iconColor = bridge.paired ? kMint : kMuted;
    display.fillCircle(48, y + 29, 21, bridge.paired ? 0x0868 : 0x1083);
    drawHostIcon(display, 48, y + 28, iconColor);
    display.setTextColor(kWhite);
    display.setCursor(80, y + 11);
    display.print(bridge.name.substring(0, 36));
    display.setTextColor(kMuted);
    display.setCursor(80, y + 33);
    display.print(bridge.paired ? "PAIRED" : "TAP TO PAIR");
    drawChevron(display, 332, y + 29, kMint);
  }
  drawFooter("BOOT Refresh     Swipe for more");
}

void RemoteApp::drawConversation() {
  Arduino_GFX &display = Board::display();
  display.fillCircle(34, 82, 20, kPanel);
  display.drawCircle(34, 82, 20, kCyan);
  display.drawLine(39, 71, 28, 82, kWhite);
  display.drawLine(28, 82, 39, 93, kWhite);

  if (_client.activeThreadId().isEmpty()) {
    drawOrb(display, SCREEN_WIDTH_PX / 2, 210, 58, true);
    drawCenteredText(display, "LOADING THREAD", 284, 2, kMint);
    return;
  }

  display.setTextSize(1);
  display.setTextColor(kWhite);
  display.setCursor(64, 78);
  display.print(_client.activeThreadTitle().substring(0, 43));

  if (_recording) {
    drawOrb(display, SCREEN_WIDTH_PX / 2, 185, 75, true);
    drawWaveform(display, 306, true);
    drawCenteredText(display, "LISTENING...", 346, 2, kMint);
    drawCenteredText(display, "Release BOOT to send", 378, 1, kWhite);
    drawFooter("Listening through the board mic");
    return;
  }

  if (_awaitingResponse) {
    drawOrb(display, SCREEN_WIDTH_PX / 2, 176, 48, true);
    drawWaveform(display, 278, true);
    drawCenteredText(display, "CODEX IS THINKING", 325, 2, kMint);
    drawCenteredText(display, "Your request is on its way", 356, 1, kMuted);
    drawFooter("Waiting for reply");
    return;
  }

  const int index = readerMessageIndex();
  if (index < 0) {
    display.fillCircle(SCREEN_WIDTH_PX / 2, 218, 61, kPanel);
    display.fillArc(SCREEN_WIDTH_PX / 2, 218, 63, 60, 135, 315, kCyan);
    display.fillArc(SCREEN_WIDTH_PX / 2, 218, 63, 60, 315, 360, kViolet);
    display.fillArc(SCREEN_WIDTH_PX / 2, 218, 63, 60, 0, 135, kViolet);
    drawMicrophone(display, SCREEN_WIDTH_PX / 2, 212, kWhite);
    drawCenteredText(display, "HOLD BOOT TO TALK", 302, 2, kMint);
    drawCenteredText(display, "Release it to send", 332, 1, kMuted);
    drawFooter("Touch back to choose another thread");
    return;
  }

  const RemoteMessage &message = _client.message(index);
  const int pageCount = messagePageCount(message);
  const String position = String(index + 1) + "/" +
                          String(_client.messageCount()) + "  PAGE " +
                          String(_readerPage + 1) + "/" + String(pageCount);
  display.setTextColor(kMuted);
  display.setCursor(SCREEN_WIDTH_PX - 16 - position.length() * 6, 100);
  display.print(position);

  const bool user = message.role == "user";
  display.fillRoundRect(16, 113, 336, 278, 17,
                        user ? kPanelSelected : kPanel);
  display.drawRoundRect(16, 113, 336, 278, 17, user ? kBlue : kPanelGlow);
  display.fillCircle(43, 142, 18, user ? 0x10A5 : 0x0868);
  if (user) {
    drawMicrophone(display, 43, 139, kCyan);
  } else {
    drawSpark(display, 43, 142, 10, kMint);
  }
  display.setTextSize(1);
  display.setTextColor(user ? kCyan : kMint);
  display.setCursor(70, 132);
  display.print(user ? "YOU SAID" : "CODEX REPLY");
  if (_readerPage > 0) {
    display.setTextColor(kMuted);
    display.print("  CONTINUED");
  }
  if (message.status == "streaming") {
    display.setTextColor(kMint);
    display.print("  *");
  }
  drawMessageTextPage(message.text, _readerPage, 30, 166,
                      kMessageCharactersPerLine, kMessageLinesPerPage,
                      user ? kCyan : kWhite);
  drawFooter(_playbackActive ? "Playing reply through speaker"
                             : "BOOT Hold to talk     Swipe pages");
}

void RemoteApp::drawFooter(const char *label) {
  Arduino_GFX &display = Board::display();
  display.fillRoundRect(20, 411, 328, 25, 12, kPanel);
  display.setTextSize(1);
  display.setTextColor(kMuted);
  const int width = strlen(label) * 6;
  display.setCursor(max(3, (SCREEN_WIDTH_PX - width) / 2), 420);
  display.print(label);
}

void RemoteApp::drawMessageTextPage(const String &text, int page, int x, int y,
                                    int charactersPerLine, int linesPerPage,
                                    uint16_t color) {
  Arduino_GFX &display = Board::display();
  display.setTextSize(2);
  display.setTextColor(color);
  int offset = 0;
  int wrappedLine = 0;
  const int firstLine = page * linesPerPage;
  while (offset < text.length() && wrappedLine < firstLine + linesPerPage) {
    const int newline = text.indexOf('\n', offset);
    const int paragraphEnd = newline >= 0 ? newline : text.length();
    if (paragraphEnd == offset) {
      if (wrappedLine >= firstLine) {
        y += 16;
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
      y += 16;
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
