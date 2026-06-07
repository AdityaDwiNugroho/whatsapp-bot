import time
import subprocess
import requests
import base64
import os

# --- Configuration Settings ---
# Update these to match your deployed Space credentials
HF_SPACE_URL = "https://itsyurtzy-whatsapp-bot.hf.space"
DASHBOARD_PASSWORD = "your_dashboard_password_here" 
POLL_INTERVAL = 5 # seconds

def get_screenshot():
  """
  Takes a screenshot using native Windows .NET assemblies via PowerShell.
  Requires zero Python libraries (like pyautogui/pillow) to be installed.
  """
  filename = "screenshot.png"
  ps_command = (
      "[Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null; "
      "[Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; "
      "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "
      "$bmp = New-Object Drawing.Bitmap $bounds.Width, $bounds.Height; "
      "$graphics = [Drawing.Graphics]::FromImage($bmp); "
      "$graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size); "
      "$bmp.Save('" + filename + "', [Drawing.Imaging.ImageFormat]::Png); "
      "$graphics.Dispose(); "
      "$bmp.Dispose();"
  )
  
  try:
    # Run the PowerShell screenshot script
    subprocess.run(["powershell", "-Command", ps_command], capture_output=True, check=True)
    if os.path.exists(filename):
      return filename
  except Exception as e:
    print(f"[-] Screenshot capture failed: {str(e)}")
  return None

def execute_shell_command(cmd_text):
  """
  Runs a command in the Windows Command Prompt (cmd.exe) and captures stdout/stderr.
  """
  try:
    result = subprocess.run(cmd_text, shell=True, capture_output=True, text=True, timeout=30)
    stdout = result.stdout.strip()
    stderr = result.stderr.strip()
    
    output = ""
    if stdout:
      output += stdout
    if stderr:
      if output:
        output += "\n"
      output += f"Errors:\n{stderr}"
      
    if not output:
      output = "Command executed successfully with no console output."
      
    return output
  except subprocess.TimeoutExpired:
    return "Error: Command timed out after 30 seconds."
  except Exception as e:
    return f"Error executing command: {str(e)}"

def poll_and_execute():
  headers = {
      "Content-Type": "application/json"
  }
  if DASHBOARD_PASSWORD:
    headers["x-password"] = DASHBOARD_PASSWORD

  # Construct API URLs
  get_url = f"{HF_SPACE_URL}/api/pc/commands"
  respond_url = f"{HF_SPACE_URL}/api/pc/respond"

  try:
    response = requests.get(get_url, headers=headers, timeout=10)
    if response.status_code == 401:
      print("[-] Unauthorized. Please check your DASHBOARD_PASSWORD configuration.")
      return
    elif response.status_code != 200:
      print(f"[-] Server returned status code: {response.status_code}")
      return

    commands = response.json()
    if not commands:
      return

    for cmd in commands:
      cmd_id = cmd["id"]
      command_text = cmd["command"]
      print(f"[+] Processing command [{cmd_id}]: {command_text}")

      response_payload = {
          "id": cmd_id,
          "response": ""
      }

      # Check for special commands
      if command_text.lower() == "screenshot":
        filepath = get_screenshot()
        if filepath and os.path.exists(filepath):
          try:
            with open(filepath, "rb") as f:
              b64_data = base64.b64encode(f.read()).decode("utf-8")
            response_payload["fileData"] = f"data:image/png;base64,{b64_data}"
            response_payload["filename"] = filepath
            response_payload["response"] = "PC Screenshot captured successfully."
          except Exception as read_err:
            response_payload["response"] = f"Failed to read screenshot file: {str(read_err)}"
          finally:
            if os.path.exists(filepath):
              os.remove(filepath) # Clean up file after reading
        else:
          response_payload["response"] = "Failed to capture PC screenshot."
      else:
        # Run generic terminal command
        cmd_output = execute_shell_command(command_text)
        response_payload["response"] = f"Output of command [{command_text}]:\n{cmd_output}"

      # Send response back to Hugging Face
      post_resp = requests.post(respond_url, headers=headers, json=response_payload, timeout=15)
      if post_resp.status_code == 200:
        print(f"[+] Successfully returned response for command [{cmd_id}]")
      else:
        print(f"[-] Failed to send response back to server: {post_resp.status_code} - {post_resp.text}")

  except requests.exceptions.RequestException as req_err:
    # Silently ignore connection timeouts or temporary network drops
    pass
  except Exception as err:
    print(f"[-] Error in loop: {str(err)}")

if __name__ == "__main__":
  print("==================================================")
  print("   WHATSAPP CLOUD BOT - LOCAL PC CONNECTOR        ")
  print("==================================================")
  print(f"[+] Target Server: {HF_SPACE_URL}")
  print("[+] Watching for incoming commands from WhatsApp JID...")
  print("[+] Press Ctrl+C to terminate connection.")
  
  if DASHBOARD_PASSWORD == "your_dashboard_password_here":
    print("\n[WARNING] Please open pc-connector.py and update DASHBOARD_PASSWORD with your actual secret password!\n")

  while True:
    poll_and_execute()
    time.sleep(POLL_INTERVAL)
