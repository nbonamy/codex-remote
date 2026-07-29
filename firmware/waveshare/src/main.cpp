#include "app/RemoteApp.h"

RemoteApp app;

void setup() {
  if (!app.begin()) {
    Serial.println("Codex Remote initialization failed");
  }
}

void loop() { app.update(); }
