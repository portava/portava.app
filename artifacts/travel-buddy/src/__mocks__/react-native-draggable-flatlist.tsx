/**
 * Jest stub for react-native-draggable-flatlist.
 *
 * Renders items in a plain View so component tests can assert on list content
 * without pulling in react-native-gesture-handler / reanimated native modules.
 * The drag() callback is a no-op; onDragEnd is never called (tests use the
 * arrow-button fallback path to assert on reorder behaviour).
 */
import React from 'react';
import { View } from 'react-native';

function DraggableFlatList({
  data,
  renderItem,
  keyExtractor,
  ListFooterComponent,
  ListHeaderComponent,
  containerStyle,
}: any) {
  return (
    <View style={containerStyle}>
      {ListHeaderComponent
        ? typeof ListHeaderComponent === 'function'
          ? React.createElement(ListHeaderComponent)
          : ListHeaderComponent
        : null}
      {(data ?? []).map((item: any, index: number) => {
        const key = keyExtractor ? keyExtractor(item, index) : String(index);
        return (
          <View key={key}>
            {renderItem({ item, drag: () => {}, isActive: false, getIndex: () => index })}
          </View>
        );
      })}
      {ListFooterComponent
        ? typeof ListFooterComponent === 'function'
          ? React.createElement(ListFooterComponent)
          : ListFooterComponent
        : null}
    </View>
  );
}

export { DraggableFlatList };
export default DraggableFlatList;

export function ScaleDecorator({ children }: any) {
  return children;
}

export function ShadowDecorator({ children }: any) {
  return children;
}

export function OpacityDecorator({ children }: any) {
  return children;
}

export function NestableScrollContainer({ children, style }: any) {
  return <View style={style}>{children}</View>;
}

export function NestableDraggableFlatList(props: any) {
  return DraggableFlatList(props);
}
