#pragma once

#include <Arduino.h>

#if __has_include("credentials.h")
#include "credentials.h"
#endif

#ifndef CODEX_REMOTE_WIFI_SSID
#define CODEX_REMOTE_WIFI_SSID ""
#endif
#ifndef CODEX_REMOTE_WIFI_PASSWORD
#define CODEX_REMOTE_WIFI_PASSWORD ""
#endif
#ifndef CODEX_REMOTE_SERVER_HOST
#define CODEX_REMOTE_SERVER_HOST ""
#endif
#ifndef CODEX_REMOTE_SERVER_PORT
#define CODEX_REMOTE_SERVER_PORT 47776
#endif
#ifndef CODEX_REMOTE_BOARD_V2
#define CODEX_REMOTE_BOARD_V2 0
#endif

constexpr const char *WIFI_SSID = CODEX_REMOTE_WIFI_SSID;
constexpr const char *WIFI_PASSWORD = CODEX_REMOTE_WIFI_PASSWORD;
constexpr const char *SERVER_HOST = CODEX_REMOTE_SERVER_HOST;
constexpr int SERVER_PORT = CODEX_REMOTE_SERVER_PORT;

constexpr int WIFI_CONNECT_TIMEOUT_SEC = 15;
constexpr unsigned long RECONNECT_INTERVAL_MS = 3000;
constexpr unsigned long DISCOVERY_REFRESH_INTERVAL_MS = 5000;
constexpr unsigned long PAIRING_RETRY_INTERVAL_MS = 2000;

// The Codex Remote device audio bridge uses mono PCM16LE at 24 kHz.
constexpr int MIC_SAMPLE_RATE = 24000;
constexpr int MIC_CHUNK_MS = 80;
constexpr int PLAY_SAMPLE_RATE = 24000;
constexpr int MAX_PLAYBACK_SEC = 30;

constexpr int SCREEN_WIDTH_PX = 368;
constexpr int SCREEN_HEIGHT_PX = 448;
constexpr int DEFAULT_BRIGHTNESS = 90;
constexpr int DEFAULT_VOLUME = 180;
constexpr bool SHOW_BOOT_LOG_ON_DISPLAY = false;
constexpr bool SHOW_DEBUG_TEXT_ON_DISPLAY = false;

constexpr int LCD_SDIO0_PIN = 4;
constexpr int LCD_SDIO1_PIN = 5;
constexpr int LCD_SDIO2_PIN = 6;
constexpr int LCD_SDIO3_PIN = 7;
constexpr int LCD_SCLK_PIN = 11;
constexpr int LCD_CS_PIN = 12;

constexpr int BOARD_I2C_SDA_PIN = 15;
constexpr int BOARD_I2C_SCL_PIN = 14;
constexpr int TOUCH_INTERRUPT_PIN = 21;
constexpr uint8_t TOUCH_FT3168_ADDRESS = 0x38;
constexpr uint8_t TOUCH_CST820_ADDRESS = 0x15;

constexpr gpio_num_t BUTTON_A_PIN = GPIO_NUM_0;
constexpr gpio_num_t BUTTON_B_PIN = GPIO_NUM_NC;

constexpr int AUDIO_I2S_MCLK_PIN = 16;
constexpr int AUDIO_I2S_BCLK_PIN = 9;
constexpr int AUDIO_I2S_DIN_PIN = 10;
constexpr int AUDIO_I2S_WS_PIN = 45;
constexpr int AUDIO_I2S_DOUT_PIN = 8;
constexpr int AUDIO_PA_ENABLE_PIN = 46;

constexpr int BRIGHTNESS_OFF = 0;
