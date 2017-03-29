import React, { Componet } from 'react';
import { Router, Route, hashHistory, IndexRoute } from 'react-router';
import ReactDOM from 'react-dom';

import Header from './ui/header';
import Content from './ui/content';
import Dashboard from './ui/dashboard/dashboard';
import NewConfigurationForm from './ui/backup/config/new-configuration';

import '../sass/style.scss';
import 'react-select/dist/react-select.css';

const PlaceHolder = ({ children, location }) => {
     return (
         <div className="mongo-backup-manager">
             <Header/>
             <Content>
                 { children }
             </Content>
         </div>
     )
};

const App = () => {
    return (
        <Router history={ hashHistory }>
            <Route path='/' component={ PlaceHolder }>
                <IndexRoute component={ Dashboard }/>
                <Route path='/newConfig' component={ NewConfigurationForm }/>
            </Route>
        </Router>
    )
};

ReactDOM.render(<App></App>, document.getElementById('app'));
