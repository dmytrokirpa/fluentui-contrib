import * as React from 'react';
import type { StoryFn } from '@storybook/react-webpack5';
import './styles.css';

import {
  UnstyledTabList,
  UnstyledTab,
} from '@fluentui-contrib/react-unstyled-components';

export const Default: StoryFn<typeof UnstyledTabList> = () => (
  <div style={{ display: 'flex', flexDirection: 'row', gap: '1rem' }}>
    <UnstyledTabList className="tabs" defaultSelectedValue="tab2">
      <UnstyledTab className="tab" value="tab1">
        Tab 1
      </UnstyledTab>
      <UnstyledTab className="tab" value="tab2">
        Tab 2
      </UnstyledTab>
      <UnstyledTab className="tab" value="tab3">
        Tab 3
      </UnstyledTab>
      <UnstyledTab className="tab" value="tab4" disabled>
        Tab 4
      </UnstyledTab>
    </UnstyledTabList>
  </div>
);
