import os
from dotenv import load_dotenv
from google import genai

# 1. Load the environment variables from the .env file
load_dotenv()

# 2. Initialize the Gemini client 
# It automatically looks for the "GEMINI_API_KEY" variable in your environment
client = genai.Client()

def generate_text(prompt_text):
    try:
        # 3. Call the standard Gemini model (gemini-2.5-flash)
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt_text,
        )
        return response.text
    except Exception as e:
        return f"An error occurred: {e}"

if __name__ == "__main__":
    print("Sending prompt to Gemini...")
    user_prompt = "Give me a one-sentence tagline for a local coffee shop."
    
    result = generate_text(user_prompt)
    print("\nGemini Response:")
    print(result)