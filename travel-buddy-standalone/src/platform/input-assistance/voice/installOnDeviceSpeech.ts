import { requireOptionalNativeModule } from 'expo-modules-core';
import { createOnDeviceSpeech, type OnDeviceSpeechModule } from './onDeviceSpeech.ts';
import { installSpeechRecognizer } from './speechRecognizer.ts';

// Registration performs no permission request, microphone capture, model download or remote fallback.
// Web/Expo Go/older native builds retain the resolver's explicit unavailable state.
const nativeSpeech = requireOptionalNativeModule<OnDeviceSpeechModule>('PortavaOnDeviceSpeech');
if (nativeSpeech) installSpeechRecognizer(createOnDeviceSpeech(nativeSpeech));
