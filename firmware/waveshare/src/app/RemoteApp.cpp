#include "RemoteApp.h"

#include "../Config.h"
#include "../diag/Log.h"
#include "../hal/Board.h"

namespace {
constexpr uint16_t kBlack = 0x0000;
constexpr uint16_t kPanel = 0x0861;
constexpr uint16_t kPanelSelected = 0x10E3;
constexpr uint16_t kLine = 0x2945;
constexpr uint16_t kWhite = 0xF79D;
constexpr uint16_t kMuted = 0x8C91;
constexpr uint16_t kMint = 0x87B8;
constexpr uint16_t kCyan = 0x66BF;
constexpr uint16_t kCoral = 0xFB4B;
constexpr uint16_t kYellow = 0xFE88;
constexpr int kThreadsPerPage = 5;
constexpr int kMessageCharactersPerLine = 50;
constexpr int kMessageLinesPerPage = 28;
constexpr int kSwipeThresholdPx = 48;
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
  if (_dirty || millis() - _lastDrawMs > 500) {
    draw();
  }
  delay(2);
}

void RemoteApp::onRemoteStateChanged() {
  const int lastPage =
      max(0, (_client.threadCount() + kThreadsPerPage - 1) / kThreadsPerPage - 1);
  _threadPage = min(_threadPage, lastPage);
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
  } else {
    if (buttonA && !_buttonAPrevious) {
      startRecording();
    }
    if (!buttonA && _buttonAPrevious && _recording) {
      stopRecording();
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
    if (y < 84 || y >= 374) {
      return;
    }
    const int visibleIndex = (y - 84) / 58;
    if (visibleIndex < 0 || visibleIndex >= kThreadsPerPage) {
      return;
    }
    openThread(_threadPage * kThreadsPerPage + visibleIndex);
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
    drawFooter("BOOT  New thread");
  } else {
    drawConversation();
    drawFooter(_recording ? "BOOT  Release" : "BOOT  Hold to talk");
  }
  _lastDrawMs = millis();
  _dirty = false;
}

void RemoteApp::drawHeader() {
  Arduino_GFX &display = Board::display();
  display.drawFastHLine(0, 53, SCREEN_WIDTH_PX, kLine);
  display.setTextSize(2);
  display.setTextColor(kMint);
  display.setCursor(16, 18);
  display.print(">_");
  display.setTextSize(1);
  display.setTextColor(kWhite);
  display.setCursor(50, 22);
  display.print("CODEX REMOTE");

  display.fillCircle(319, 27, 4, _client.connected() ? kMint : kCoral);
  display.setTextColor(kMuted);
  display.setCursor(330, 23);
  display.print(_client.connected() ? "ON" : "OFF");
}

void RemoteApp::drawThreads() {
  Arduino_GFX &display = Board::display();
  display.setTextSize(1);
  display.setTextColor(kMuted);
  display.setCursor(16, 69);
  const int first = _threadPage * kThreadsPerPage;
  const int last = min(_client.threadCount(), first + kThreadsPerPage);
  if (_client.threadCount() == 0) {
    display.print("NO RECENT THREADS");
  } else {
    display.printf("%d-%d / %d THREADS", first + 1, last,
                   _client.threadCount());
  }

  for (int visible = 0; visible < kThreadsPerPage; visible++) {
    const int index = first + visible;
    if (index >= _client.threadCount()) {
      break;
    }
    const int y = 84 + visible * 58;
    display.fillRoundRect(14, y, 340, 50, 11, kPanel);
    display.setTextColor(kMuted);
    display.setCursor(26, y + 19);
    display.print(">");
    display.setTextColor(kWhite);
    display.setCursor(48, y + 9);
    display.print(_client.thread(index).title.substring(0, 42));
    display.setTextColor(kMuted);
    display.setCursor(48, y + 29);
    display.print(_client.thread(index).preview.substring(0, 47));
  }
}

void RemoteApp::drawConversation() {
  Arduino_GFX &display = Board::display();
  display.drawRoundRect(14, 65, 30, 30, 8, kLine);
  display.setTextSize(2);
  display.setTextColor(kWhite);
  display.setCursor(24, 70);
  display.print("<");

  if (_client.activeThreadId().isEmpty()) {
    display.setTextSize(1);
    display.setTextColor(kMuted);
    display.setCursor(140, 220);
    display.print("LOADING...");
    return;
  }

  display.setTextSize(2);
  display.setTextColor(kWhite);
  display.setCursor(52, 69);
  display.print(_client.activeThreadTitle().substring(0, 20));

  display.setTextSize(1);
  display.setTextColor(_client.activeThreadBusy() ? kYellow : kMuted);
  display.setCursor(16, 94);
  if (_recording) {
    display.print("LISTENING");
  } else if (_awaitingResponse) {
    display.print("NEW RESPONSE - PAGE 1 - WAITING");
  }

  if (_awaitingResponse) {
    display.fillRoundRect(14, 112, 340, 276, 12, kPanel);
    display.setTextColor(kMuted);
    display.setCursor(133, 244);
    display.print("WAITING FOR CODEX...");
    return;
  }

  const int index = readerMessageIndex();
  if (index < 0) {
    display.setTextColor(kMuted);
    display.setCursor(16, 147);
    display.print("Hold BOOT and tell Codex what to do.");
    return;
  }

  const RemoteMessage &message = _client.message(index);
  const int pageCount = messagePageCount(message);
  if (!_recording) {
    const String position =
        String(index + 1) + "/" + String(_client.messageCount()) + "  PAGE " +
        String(_readerPage + 1) + "/" + String(pageCount);
    display.setTextColor(kMuted);
    display.setCursor(SCREEN_WIDTH_PX - 16 - position.length() * 6, 94);
    display.print(position);
  }

  const bool user = message.role == "user";
  display.fillRoundRect(14, 112, 340, 276, 12, user ? 0x08C4 : kPanel);
  display.setTextColor(user ? kCyan : kMint);
  display.setCursor(27, 125);
  display.print(user ? "YOU" : "CODEX");
  if (_readerPage > 0) {
    display.setTextColor(kMuted);
    display.print("  CONTINUED");
  }
  if (message.status == "streaming") {
    display.setTextColor(kMint);
    display.print("  *");
  }
  drawMessageTextPage(message.text, _readerPage, 27, 145,
                      kMessageCharactersPerLine, kMessageLinesPerPage,
                      user ? kCyan : kWhite);
}

void RemoteApp::drawFooter(const char *label) {
  Arduino_GFX &display = Board::display();
  display.drawFastHLine(0, 399, SCREEN_WIDTH_PX, kLine);
  display.setTextSize(1);
  display.setTextColor(kWhite);
  const int width = strlen(label) * 6;
  display.setCursor((SCREEN_WIDTH_PX - width) / 2, 420);
  display.print(label);
}

void RemoteApp::drawMessageTextPage(const String &text, int page, int x, int y,
                                    int charactersPerLine, int linesPerPage,
                                    uint16_t color) {
  Arduino_GFX &display = Board::display();
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
        y += 8;
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
      y += 8;
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
