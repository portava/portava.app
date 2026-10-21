import React from 'react';
import {render,screen,fireEvent,waitFor} from '@testing-library/react-native';
import {LayoverSpecialistDeclaration} from '../LayoverSpecialistDeclaration.tsx';
import {updateOffer} from '../../../services/rentABuddy.ts';
import {router} from 'expo-router';
// NOTE: intentional stub — network result drives the server-owned declaration; display stays unchanged on refusal.
jest.mock('../../../services/rentABuddy.ts',()=>({...jest.requireActual('../../../services/rentABuddy.ts'),updateOffer:jest.fn()}));
jest.mock('expo-router',()=>({router:{push:jest.fn()}}));
afterEach(()=>jest.clearAllMocks());
it('requires a successful server declaration before showing the saved specialism',async()=>{
 const saved=jest.fn();(updateOffer as jest.Mock).mockResolvedValue({ok:false,error:'layover_identity_verification_required'});await render(<LayoverSpecialistDeclaration categories={['city']} onSaved={saved}/>);
 await fireEvent(screen.getByLabelText('Offer layover specialist services'),'valueChange',true);await waitFor(()=>expect(screen.getByText('Open identity verification')).toBeTruthy());expect(updateOffer).toHaveBeenCalledWith({categories:['city','layover']});expect(saved).not.toHaveBeenCalled();expect(screen.getByLabelText('Offer layover specialist services').props.value).toBe(false);await fireEvent.press(screen.getByText('Open identity verification'));expect(router.push).toHaveBeenCalledWith('/profile/verification');
});
it('saves an eligible declaration and permits removing it',async()=>{
 const saved=jest.fn();(updateOffer as jest.Mock).mockResolvedValue({ok:true,data:{ok:true}});const view=await render(<LayoverSpecialistDeclaration categories={['city']} onSaved={saved}/>);await fireEvent(screen.getByLabelText('Offer layover specialist services'),'valueChange',true);await waitFor(()=>expect(saved).toHaveBeenCalledTimes(1));await view.rerender(<LayoverSpecialistDeclaration categories={['city','layover']} onSaved={saved}/>);await fireEvent(screen.getByLabelText('Offer layover specialist services'),'valueChange',false);await waitFor(()=>expect(updateOffer).toHaveBeenLastCalledWith({categories:['city']}));
});
