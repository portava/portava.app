import React from 'react';
import {View} from 'react-native';
import {Image} from 'expo-image';
/** Official static mark, unmodified from GIPHY's attribution asset archive. */
export function GiphyAttribution(){return <View style={{alignSelf:'flex-start',backgroundColor:'#000',padding:8,borderRadius:4}}><Image source={require('./powered-by-giphy.png')} style={{width:200,height:26}} contentFit="contain" accessibilityLabel="Powered by GIPHY"/></View>;}
