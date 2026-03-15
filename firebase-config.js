// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBph8A8njpDLIwE9JfB_Yr7j9CdKvKqDQA",
  authDomain: "voidchat-72ed4.firebaseapp.com",
  projectId: "voidchat-72ed4",
  storageBucket: "voidchat-72ed4.firebasestorage.app",
  messagingSenderId: "355987303332",
  appId: "1:355987303332:web:a516052ee354afa174ef31",
  measurementId: "G-7EFMT3C0K0"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
