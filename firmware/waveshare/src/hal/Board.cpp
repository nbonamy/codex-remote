#include "Board.h"

#include "../Config.h"
#include "diag/Log.h"
#include <Wire.h>
#include <XPowersLib.h>
#include <driver/gpio.h>
#include <esp_sleep.h>

namespace {
/// QSPI bus used by the display panel.
Arduino_DataBus *displayBus =
    new Arduino_ESP32QSPI(LCD_CS_PIN, LCD_SCLK_PIN, LCD_SDIO0_PIN,
                          LCD_SDIO1_PIN, LCD_SDIO2_PIN, LCD_SDIO3_PIN);
/// Shared display panel instance.
#if CODEX_REMOTE_BOARD_V2
Arduino_CO5300 *displayPanel =
    new Arduino_CO5300(displayBus, GFX_NOT_DEFINED, 0, SCREEN_WIDTH_PX,
                       SCREEN_HEIGHT_PX, 16, 0, 0, 0);
#else
Arduino_SH8601 *displayPanel = new Arduino_SH8601(
    displayBus, GFX_NOT_DEFINED, 0, SCREEN_WIDTH_PX, SCREEN_HEIGHT_PX);
#endif
/// Indexed PSRAM canvas prevents visible partial redraws and supports captures.
Arduino_Canvas_Indexed *displayCanvas = new Arduino_Canvas_Indexed(
    SCREEN_WIDTH_PX, SCREEN_HEIGHT_PX, displayPanel);

/// Power-management IC driver instance.
XPowersPMU pmu;
/// Whether the PMU initialized successfully.
bool pmuReady = false;
/// Latched state of the PMU power button.
bool pwrPressed = false;
/// Timestamp until which a PMU button pulse remains visible.
unsigned long pwrPulseUntilMs = 0;
/// Timestamp of the last PMU IRQ poll.
unsigned long lastPmuPollMs = 0;
/// Detected touch controller address, or zero when unavailable.
uint8_t touchAddress = 0;
/// Last cached touch state.
Board::TouchPoint cachedTouch;
/// Timestamp of the last touch-controller poll.
unsigned long lastTouchPollMs = 0;
/// Last brightness written to the display.
uint8_t currentBrightness = DEFAULT_BRIGHTNESS;
const DeviceCapabilities kCapabilities = {.externalSpeakerSwitch = false,
                                          .externalSpeakerGain = false,
                                          .lightSleep = true,
                                          .batteryLevel = true,
                                          .batteryVoltage = true,
                                          .usbPowerStatus = true,
                                          .endpointPreference = true,
                                          .bootDisplay =
                                              SHOW_BOOT_LOG_ON_DISPLAY,
                                          .debugDisplay =
                                              SHOW_DEBUG_TEXT_ON_DISPLAY};

/**
 * @brief Enable PMU ADC channels used for power telemetry.
 */
void enablePmuAdc() {
  pmu.enableTemperatureMeasure();
  pmu.enableBattDetection();
  pmu.enableVbusVoltageMeasure();
  pmu.enableBattVoltageMeasure();
  pmu.enableSystemVoltageMeasure();
}

bool i2cDevicePresent(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

bool writeI2cRegister(uint8_t address, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readI2cRegisters(uint8_t address, uint8_t reg, uint8_t *data,
                      size_t length) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    return false;
  }
  if (Wire.requestFrom(address, static_cast<uint8_t>(length)) != length) {
    return false;
  }
  for (size_t index = 0; index < length; index++) {
    data[index] = Wire.read();
  }
  return true;
}

void initTouch() {
  pinMode(TOUCH_INTERRUPT_PIN, INPUT_PULLUP);
  if (i2cDevicePresent(TOUCH_CST820_ADDRESS)) {
    touchAddress = TOUCH_CST820_ADDRESS;
    // Periodic touch interrupts; polling remains the source of coordinates.
    writeI2cRegister(touchAddress, 0xFA, 0x40);
    Log::client("Board", "CST820 touch online");
    return;
  }
  if (i2cDevicePresent(TOUCH_FT3168_ADDRESS)) {
    touchAddress = TOUCH_FT3168_ADDRESS;
    // Monitor mode is the Waveshare default for the FT3168.
    writeI2cRegister(touchAddress, 0xA5, 0x01);
    Log::client("Board", "FT3168 touch online");
    return;
  }
  Log::client("Board", "touch controller not found");
}

/**
 * @brief Poll PMU power-button IRQ state and update cached flags.
 */
void pollPmuButton() {
  if (!pmuReady || millis() - lastPmuPollMs < 20) {
    return;
  }
  const unsigned long now = millis();
  lastPmuPollMs = now;

  pmu.getIrqStatus();
  const bool negative = pmu.isPekeyNegativeIrq();
  const bool positive = pmu.isPekeyPositiveIrq();
  const bool shortPress = pmu.isPekeyShortPressIrq();
  const bool longPress = pmu.isPekeyLongPressIrq();

  if (negative) {
    pwrPressed = true;
    pwrPulseUntilMs = 0;
  }
  if (positive) {
    pwrPressed = false;
    pwrPulseUntilMs = 0;
  }
  if (shortPress) {
    if (negative || positive || pwrPressed) {
      pwrPressed = false;
      pwrPulseUntilMs = 0;
    } else {
      pwrPulseUntilMs = now + 180;
    }
  }
  if (longPress && !pwrPressed && !negative && !positive) {
    pwrPulseUntilMs = now + 1200;
  }
  pmu.clearIrqStatus();
}
} // namespace

namespace Board {
const DeviceCapabilities &capabilities() { return kCapabilities; }

/**
 * @brief Initialize board GPIO, I2C, PMU, and amplifier defaults.
 * @return True after initialization completes.
 */
bool init() {
  pinMode(BUTTON_A_PIN, INPUT_PULLUP);
  pinMode(AUDIO_PA_ENABLE_PIN, OUTPUT);
  digitalWrite(AUDIO_PA_ENABLE_PIN, HIGH);

  Wire.begin(BOARD_I2C_SDA_PIN, BOARD_I2C_SCL_PIN);
  Wire.setClock(400000);

  pmuReady = pmu.begin(Wire, AXP2101_SLAVE_ADDRESS, BOARD_I2C_SDA_PIN,
                       BOARD_I2C_SCL_PIN);
  if (pmuReady) {
    pmu.disableIRQ(XPOWERS_AXP2101_ALL_IRQ);
    pmu.clearIrqStatus();
    pmu.setChargeTargetVoltage(3);
    pmu.enableIRQ(
        XPOWERS_AXP2101_PKEY_POSITIVE_IRQ | XPOWERS_AXP2101_PKEY_NEGATIVE_IRQ |
        XPOWERS_AXP2101_PKEY_SHORT_IRQ | XPOWERS_AXP2101_PKEY_LONG_IRQ);
    enablePmuAdc();
    Log::client("Board", "AXP2101 online batt=%dmV pct=%d vbus=%dmV",
                pmu.getBattVoltage(), pmu.getBatteryPercent(),
                pmu.getVbusVoltage());
  } else {
    Log::client("Board", "AXP2101 not found");
  }

  initTouch();
  return true;
}

/**
 * @brief Service board-level background polling.
 */
void update() { pollPmuButton(); }

/**
 * @brief Access the shared display driver.
 * @return Reference to the display panel.
 */
Arduino_GFX &display() { return *displayCanvas; }

void flushDisplay() { displayCanvas->flush(); }

void writeDisplayScreenshot(Stream &stream) {
  stream.printf("CODEX_REMOTE_SCREENSHOT_V1 %d %d\n", SCREEN_WIDTH_PX,
                SCREEN_HEIGHT_PX);
  stream.write(reinterpret_cast<const uint8_t *>(
                   displayCanvas->getColorIndex()),
               256 * sizeof(uint16_t));
  stream.write(displayCanvas->getFramebuffer(),
               SCREEN_WIDTH_PX * SCREEN_HEIGHT_PX);
  stream.flush();
}

bool touchAvailable() { return touchAddress != 0; }

bool readTouch(TouchPoint &point) {
  const unsigned long now = millis();
  if (now - lastTouchPollMs < 12) {
    point = cachedTouch;
    return point.pressed;
  }
  lastTouchPollMs = now;
  if (touchAddress == 0) {
    cachedTouch = {};
    point = cachedTouch;
    return false;
  }

  uint8_t data[5] = {};
  if (!readI2cRegisters(touchAddress, 0x02, data, sizeof(data))) {
    cachedTouch = {};
    point = cachedTouch;
    return false;
  }
  const int fingers = data[0] & 0x0F;
  const int x = ((data[1] & 0x0F) << 8) | data[2];
  const int y = ((data[3] & 0x0F) << 8) | data[4];
  cachedTouch.pressed =
      fingers > 0 && x >= 0 && x < SCREEN_WIDTH_PX && y >= 0 &&
      y < SCREEN_HEIGHT_PX;
  cachedTouch.x = x;
  cachedTouch.y = y;
  point = cachedTouch;
  return point.pressed;
}

/**
 * @brief Read the current state of button A.
 * @return True when button A is pressed.
 */
bool buttonAIsPressed() { return digitalRead(BUTTON_A_PIN) == LOW; }

/**
 * @brief Read the current state of the PMU-backed button B.
 * @return True when the button is pressed or within a pulse window.
 */
bool buttonBIsPressed() { return pwrPressed || millis() < pwrPulseUntilMs; }

/**
 * @brief Apply display brightness and cache the requested value.
 * @param brightness Brightness level to apply.
 */
void setDisplayBrightness(uint8_t brightness) {
  currentBrightness = brightness;
  if (brightness == 0) {
    displayPanel->displayOff();
  } else {
    displayPanel->displayOn();
    displayPanel->setBrightness(brightness);
  }
}

/**
 * @brief Return the last requested display brightness.
 * @return Cached brightness level.
 */
uint8_t displayBrightness() { return currentBrightness; }

/**
 * @brief Enable or disable the external speaker amplifier.
 * @param enabled True to power the amplifier.
 */
void setAudioAmpEnabled(bool enabled) {
  digitalWrite(AUDIO_PA_ENABLE_PIN, enabled ? HIGH : LOW);
}

/**
 * @brief Report the battery charge percentage.
 * @return Battery percentage, or -1 if unavailable.
 */
int batteryLevel() {
  if (!pmuReady || !pmu.isBatteryConnect()) {
    return -1;
  }
  return pmu.getBatteryPercent();
}

/**
 * @brief Report the current battery voltage.
 * @return Battery voltage in millivolts, or 0 if unavailable.
 */
uint16_t batteryVoltageMv() {
  if (!pmuReady) {
    return 0;
  }
  return pmu.getBattVoltage();
}

/**
 * @brief Report the current USB VBUS voltage.
 * @return VBUS voltage in millivolts, or 0 if unavailable.
 */
uint16_t vbusVoltageMv() {
  if (!pmuReady) {
    return 0;
  }
  return pmu.getVbusVoltage();
}

/**
 * @brief Determine whether USB power is present.
 * @return True when VBUS is detected.
 */
bool usbConnected() { return pmuReady && pmu.isVbusIn(); }

/**
 * @brief Return a short label for the current power source.
 * @return "USB", "BAT", or "?" when unknown.
 */
const char *powerSourceLabel() {
  if (!pmuReady) {
    return "?";
  }
  if (usbConnected()) {
    return "USB";
  }
  if (pmu.isBatteryConnect()) {
    return "BAT";
  }
  return "?";
}

/**
 * @brief Enter one light-sleep interval and report why the device woke.
 * @param wakeIntervalMs Timer wake interval in milliseconds.
 * @return Wake reason used by shared power management.
 */
LightSleepWakeReason enterLightSleep(unsigned long wakeIntervalMs) {
  esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
  gpio_wakeup_enable(BUTTON_A_PIN, GPIO_INTR_LOW_LEVEL);
  if (BUTTON_B_PIN != GPIO_NUM_NC) {
    gpio_wakeup_enable(BUTTON_B_PIN, GPIO_INTR_LOW_LEVEL);
  }
  esp_sleep_enable_gpio_wakeup();
  esp_sleep_enable_timer_wakeup(wakeIntervalMs * 1000ULL);

  esp_light_sleep_start();

  const esp_sleep_wakeup_cause_t reason = esp_sleep_get_wakeup_cause();
  update();
  if (reason == ESP_SLEEP_WAKEUP_GPIO) {
    return LightSleepWakeReason::Button;
  }
  if (reason == ESP_SLEEP_WAKEUP_TIMER) {
    return buttonAIsPressed() || buttonBIsPressed() ? LightSleepWakeReason::Button
                                                    : LightSleepWakeReason::Timer;
  }
  return LightSleepWakeReason::Other;
}

/**
 * @brief Report why this boot resumed from deep sleep.
 * @return Deep sleep wake reason used by the shared controller.
 */
DeepSleepWakeReason deepSleepWakeReason() {
  const esp_sleep_wakeup_cause_t reason = esp_sleep_get_wakeup_cause();
  if (reason == ESP_SLEEP_WAKEUP_TIMER) {
    return DeepSleepWakeReason::Timer;
  }
  if (reason == ESP_SLEEP_WAKEUP_EXT1 || reason == ESP_SLEEP_WAKEUP_GPIO) {
    return DeepSleepWakeReason::Button;
  }
  if (reason == ESP_SLEEP_WAKEUP_UNDEFINED) {
    return DeepSleepWakeReason::None;
  }
  return DeepSleepWakeReason::Other;
}

/**
 * @brief Enter deep sleep until the timer or wake-capable button fires.
 * @param sleepUs Timer wake interval in microseconds.
 */
void enterDeepSleep(uint64_t sleepUs) {
  esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
  esp_sleep_enable_timer_wakeup(sleepUs);
  if (BUTTON_A_PIN != GPIO_NUM_NC) {
    esp_sleep_enable_ext1_wakeup(1ULL << static_cast<unsigned>(BUTTON_A_PIN),
                                 ESP_EXT1_WAKEUP_ANY_LOW);
  }
  esp_deep_sleep_start();
}

/**
 * @brief Shut down display and audio, then enter deep sleep.
 */
void powerOff() {
  setAudioAmpEnabled(false);
  setDisplayBrightness(BRIGHTNESS_OFF);

  if (pmuReady) {
    pmu.shutdown();
    delay(200);
  }
  esp_deep_sleep_start();
}
} // namespace Board
