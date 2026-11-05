import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { MemoryItemMedia } from '../MemoryItemMedia.tsx';
// NOTE: native decoders and reference network reads have their own suites; here the actual media-kind dispatch is exercised.
jest.mock('../../../components/ui/SharedVideoPlayer.tsx',()=>({SharedVideoPlayer:(props:any)=>{const R=jest.requireActual('react');const {View}=jest.requireActual('react-native');return R.createElement(View,{testID:'shared-video',...props});}}));
// NOTE: owner-only segment editing is a separate native/SQL-tested surface.
jest.mock('../MemoryVideoSegments.tsx',()=>({MemoryVideoSegments:(props:any)=>{const R=jest.requireActual('react');const {View}=jest.requireActual('react-native');return R.createElement(View,{testID:'owner-segments',...props});}}));
// NOTE: reference authorization is independently verified; this fixture checks that no image decoder receives the opaque URI.
jest.mock('../../../components/PostReferenceCard.tsx',()=>({PostReferenceCard:(props:any)=>{const R=jest.requireActual('react');const {View}=jest.requireActual('react-native');return R.createElement(View,{testID:'reference-card',...props});}}));
// NOTE: avoids the native image loader and makes incorrect routing observable.
jest.mock('../../../components/CachedImage.tsx',()=>({CachedImage:(props:any)=>{const R=jest.requireActual('react');const {View}=jest.requireActual('react-native');return R.createElement(View,{testID:'image',...props});}}));
const props={ownerId:'owner',memoryId:'memory',isOwner:false,item:{id:'item',mediaUrl:'post-media/owner/video.mp4',mediaType:'video/mp4',caption:null,position:0,createdAt:'2026-11-05'}};
it('renders another owner’s video with controlled playback instead of an image',async()=>{
 await render(<MemoryItemMedia {...props}/>);expect(screen.getByTestId('shared-video').props.autoplay).toBe(false);expect(screen.queryByTestId('image')).toBeNull();expect(screen.queryByTestId('owner-segments')).toBeNull();
});
it('retains the owner-only video segment editor',async()=>{
 await render(<MemoryItemMedia {...props} isOwner/>);expect(screen.getByTestId('owner-segments').props.memoryId).toBe('memory');expect(screen.queryByTestId('shared-video')).toBeNull();
});
it('sends explicit reference cards to their access-checked renderer',async()=>{
 await render(<MemoryItemMedia {...props} item={{...props.item,mediaType:'application/vnd.portava.post-reference+json',mediaUrl:'portava-post-reference:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}}/>);
 expect(screen.getByTestId('reference-card')).toBeTruthy();expect(screen.queryByTestId('image')).toBeNull();expect(screen.queryByTestId('shared-video')).toBeNull();
});
