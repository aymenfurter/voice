from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from openai import AzureOpenAI
import io
import json
import requests
import re
import os
import base64
from dotenv import load_dotenv

use_tts2 = False
app = Flask(__name__)
CORS(app)

# Load environment variables from .env file
load_dotenv()

# Azure Open AI Configuration
api_base = os.getenv("AOAI_API_BASE")
api_key = os.getenv("AOAI_API_KEY")
api_version = "2024-02-01"
gpt4_o = os.getenv("AOAI_GPT4_MODEL")
whisper = os.getenv("AOAI_WHISPER_MODEL")

# Azure AI Search Configuration
search_endpoint = os.getenv("AZURE_SEARCH_ENDPOINT")
search_key = os.getenv("AZURE_SEARCH_KEY")
search_index = os.getenv("AZURE_SEARCH_INDEX")

client = AzureOpenAI(
    api_key=api_key,  
    api_version=api_version,
    azure_endpoint=api_base,
)

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/static/<path:path>')
def send_static(path):
    return send_from_directory('static', path)

@app.route('/intro', methods=['POST'])
def intro():
    try:
        response_text = "Hello! I'm your virtual assistant. How can I help you today?"
        audio_content = text_to_speech(response_text)
        audio_base64 = base64.b64encode(audio_content).decode('utf-8')
        return jsonify({
            'response': response_text,
            'audio': audio_base64
        })
    except Exception as e:
        print(f"Error in intro route: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/chat', methods=['POST'])
def chat():
    data = request.json
    conversation_history = data['conversation_history']
    
    try:
        # Detect user intent
        user_intent = detect_intent(conversation_history)
        
        # Get text response from GPT
        response_text, citations = get_gpt_response(conversation_history, user_intent)
        
        # Convert response to speech
        audio_content = text_to_speech(response_text)
        
        # Encode audio to base64
        audio_base64 = base64.b64encode(audio_content).decode('utf-8')
        
        return jsonify({
            'response': response_text,
            'audio': audio_base64,
            'citations': citations
        })
    except Exception as e:
        print(f"Error in chat route: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/speech_to_text', methods=['POST'])
def speech_to_text_route():
    if 'audio' not in request.files:
        return jsonify({'error': 'No audio file provided'}), 400
    
    audio_file = request.files['audio']
    try:
        text = speech_to_text(audio_file)
        return jsonify({'text': text})
    except Exception as e:
        print(f"Error in speech_to_text route: {str(e)}")
        return jsonify({'error': str(e)}), 500

def detect_intent(conversation_history):
    last_user_message = conversation_history[-1]['content'] if conversation_history else ""
    
    intent_system_message = """You are an intent detection system. Your task is to analyze the user's message and determine their primary intent or purpose. Provide a brief, concise description of the intent in 5-10 words."""
    
    intent_messages = [
        {"role": "system", "content": intent_system_message},
        {"role": "user", "content": f"Detect the intent in this message: {last_user_message}"}
    ]
    
    intent_response = client.chat.completions.create(
        model=gpt4_o,
        messages=intent_messages,
        temperature=0,
        max_tokens=50
    )
    
    return intent_response.choices[0].message.content.strip()

def search_azure_ai(query):
    headers = {
        'Content-Type': 'application/json',
        'api-key': search_key
    }
    
    body = {
        'search': query,
        'select': 'content',
        'top': 5 
    }
    
    url = f"{search_endpoint}/indexes/{search_index}/docs/search?api-version=2021-04-30-Preview"
    
    response = requests.post(url, headers=headers, json=body)
    results = response.json()
    
    context = ""
    for result in results.get('value', []):
        context += result.get('content', '') + "\n\n"
    
    return context.strip()

def get_gpt_response(conversation_history, user_intent):
    last_user_message = conversation_history[-1]['content'] if conversation_history else ""
    print(f"Detected User Intent: {user_intent}")
    
    # Search Azure AI Search for relevant content using the detected intent
    search_context = search_azure_ai(user_intent)
    
    system_message = """You are having conversation over the phone. Start and do some smalltalk (if the user digs it) at the beginning. Use natural language and respond as someone would in a phone call. Always ask for the model, then give advice. Never ask to contact a professional. YOU ARE The proofessional. IMPORTANT: Answer in 30-40 words or less. Be concise, natural (be empatic!), friendly and act as a human. You will be given a document as a reference to help you answer the questions. Never share more than 3 steps with the user, guide them through the information step by step. (And ask if they understood each step)"""
    
    messages = [
        {
            "role": "system",
            "content": system_message,
        }
    ]
    
    # Add conversation history
    messages.extend(conversation_history)
    
    # Add the search context and user intent to the last user message
    messages.append({"role": "user", "content": f"Context: {search_context}\n\nUser Intent: {user_intent}\n\nUser Request: {last_user_message}"})

    response = client.chat.completions.create(
        model=gpt4_o,
        messages=messages,
        temperature=0,
        max_tokens=150
    )
    
    assistant_message = response.choices[0].message
    content = assistant_message.content
    
    # Since we're not using data_sources, we'll return an empty list for citations
    citations = []
    
    return content, citations

def text_to_speech(input: str):
    global use_tts2
    headers = {'Content-Type':'application/json', 'api-key': api_key}
    
    current_model = "tts2" if use_tts2 else "tts"
    
    url = f"{api_base}openai/deployments/{current_model}/audio/speech?api-version=2024-05-01-preview"
    body = {
        "input": input,
        "voice": "nova",
        "model": "tts",
        "response_format": "mp3"
    }
    response = requests.post(url, headers=headers, data=json.dumps(body))
    
    # Toggle the flag for the next call
    use_tts2 = not use_tts2
    
    return response.content

def speech_to_text(audio_file):
    buffer = io.BytesIO(audio_file.read())
    buffer.name = "audio.wav"
    result = client.audio.transcriptions.create(
        model=whisper,
        file=buffer,
    )
    buffer.close()
    return result.text

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)