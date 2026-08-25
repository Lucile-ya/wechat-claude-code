# Keeps Windows awake while bridge daemon runs (like macOS caffeinate).
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SleepUtil {
  public const uint ES_CONTINUOUS = 0x80000000;
  public const uint ES_SYSTEM_REQUIRED = 0x00000001;
  public const uint ES_AWAYMODE_REQUIRED = 0x00000040;

  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);

  public static void KeepAwake() {
    SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED);
  }
}
"@

while ($true) {
  [SleepUtil]::KeepAwake()
  Start-Sleep -Seconds 30
}
